#!/usr/bin/env node
// skill-memory — the awwwards skills' self-improving memory.
//
// The loop that FINDS lessons runs constantly (verification steps, QA pin
// shots, band compares, repairs). This keeps them:
//   record   — append one structured finding to the episodic journal
//              (~/.awwwards-mcp/skill-memory/findings.jsonl)
//   recall   — print a skill's managed rules (procedural) + recent findings
//              (episodic) so a loop start has both
//   distill  — deterministically cluster journal rules (jaccard >= 0.6) and
//              fold clusters with count >= min into the INSTALLED skill
//              copy's managed section (between skill-memory markers). LRU-
//              capped. Journal stays the source of truth; the section is a
//              rebuildable cache.
//   stats    — journal counts, top rule clusters, last distill time.
//
// The SHIPPED (repo) skill copies are never auto-edited — promoting a rule
// into the npm package is a human PR. No LLM in the loop; no dependencies.
//
// Usage:
//   node scripts/skill-memory.mjs record --skill awwwards-inspiration \
//        --phase verify --symptom "horizontal copy vanished mid-view" \
//        --rule "Full-viewport horizontal panels get one-shot entrances" \
//        [--evidence fallow-press/_qa/pin-0.33.png] [--refs "url1,url2"]
//   node scripts/skill-memory.mjs recall --skill awwwards-inspiration
//   node scripts/skill-memory.mjs distill [--min-count 2] [--cap 12]
//   node scripts/skill-memory.mjs stats

import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MEM_DIR = join(homedir(), ".awwwards-mcp", "skill-memory");
const JOURNAL = join(MEM_DIR, "findings.jsonl");
const LAST_DISTILL = join(MEM_DIR, "last-distill.json");
const INSTALLED_SKILLS = join(homedir(), ".zcode", "skills");
const PHASES = ["search", "capture", "motion-study", "build", "verify", "release", "repair"];
const MARK_START = "<!-- skill-memory:start -->";
const MARK_END = "<!-- skill-memory:end -->";

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function die(msg) {
  console.error(`skill-memory: ${msg}`);
  process.exit(1);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function readJournal() {
  if (!existsSync(JOURNAL)) return [];
  return readFileSync(JOURNAL, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null; // torn line from a killed process — skip, never crash
      }
    })
    .filter(Boolean);
}

function atomicWrite(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

function tokens(rule) {
  return new Set(
    rule.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean),
  );
}

function jaccard(a, b) {
  const inter = [...a].filter((x) => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : inter / union;
}

// ---------- record ----------
function record() {
  const skill = flag("skill");
  const phase = flag("phase");
  const symptom = flag("symptom") ?? "";
  const rule = flag("rule");
  const evidence = flag("evidence");
  const refs = (flag("refs") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  if (!skill) die("record requires --skill");
  if (!PHASES.includes(phase)) die(`record requires --phase (one of: ${PHASES.join(", ")})`);
  if (!rule || !rule.trim()) die("record requires --rule (one imperative sentence)");

  let trimmed = rule.trim();
  if (trimmed.length > 200) {
    trimmed = trimmed.slice(0, 197) + "...";
    console.error("note: rule truncated to 200 chars");
  }

  const finding = {
    at: new Date().toISOString(),
    skill,
    phase,
    symptom,
    rule: trimmed,
    ...(evidence ? { evidence: resolve(evidence) } : {}),
    ...(refs.length ? { refs } : {}),
  };
  mkdirSync(MEM_DIR, { recursive: true });
  appendFileSync(JOURNAL, JSON.stringify(finding) + "\n");
  console.log(`recorded: [${skill}/${phase}] ${trimmed}`);
  const dup = readJournal().filter(
    (f) => f.skill === skill && tokens(f.rule).size > 0 &&
      jaccard(tokens(f.rule), tokens(trimmed)) >= 0.6,
  ).length;
  if (dup >= 2) console.log(`cluster count now ${dup} — distill will fold this into the skill (>=2)`);
}

// ---------- distill ----------
function distill() {
  const minCount = Number(flag("min-count") ?? 2);
  const cap = Number(flag("cap") ?? 12);
  const journal = readJournal();
  if (!journal.length) {
    console.log("journal empty — nothing to distill");
    process.exit(0);
  }

  // cluster by skill, then by rule-token jaccard >= 0.6 (seed = first seen)
  const bySkill = new Map();
  for (const f of journal) {
    if (!bySkill.has(f.skill)) bySkill.set(f.skill, []);
    bySkill.get(f.skill).push(f);
  }

  let foldedSkills = 0;
  let foldedRules = 0;
  const summary = [];

  for (const [skill, findings] of bySkill) {
    const clusters = [];
    for (const f of findings) {
      const t = tokens(f.rule);
      if (!t.size) continue;
      const hit = clusters.find((c) => jaccard(c.tokens, t) >= 0.6);
      if (hit) {
        hit.findings.push(f);
        for (const tok of t) hit.tokens.add(tok);
      } else {
        clusters.push({ tokens: new Set(t), findings: [f] });
      }
    }

    const promoted = clusters
      .filter((c) => c.findings.length >= minCount)
      .map((c) => {
        const dates = c.findings.map((f) => f.at.slice(0, 10)).sort();
        const evidence = c.findings.find((f) => f.evidence)?.evidence;
        return { rule: c.findings[0].rule, count: c.findings.length, lastSeen: dates[dates.length - 1], evidence };
      })
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || b.count - a.count)
      .slice(0, cap);

    const installed = join(INSTALLED_SKILLS, skill, "SKILL.md");
    if (!promoted.length || !existsSync(installed)) {
      if (!existsSync(installed)) summary.push(`${skill}: installed copy not found at ${installed} — skipped`);
      continue;
    }

    const lines = promoted.map(
      (p) => `- [${p.lastSeen} ×${p.count}] ${p.rule}${p.evidence ? ` (evidence: ${p.evidence})` : ""}`,
    );
    const section = `${MARK_START}\n<!-- machine-managed by scripts/skill-memory.mjs — source of truth: ~/.awwwards-mcp/skill-memory/findings.jsonl -->\n${lines.join("\n")}\n${MARK_END}`;

    const src = readFileSync(installed, "utf8");
    let out;
    if (src.includes(MARK_START) && src.includes(MARK_END)) {
      const start = src.indexOf(MARK_START);
      const end = src.indexOf(MARK_END) + MARK_END.length;
      out = src.slice(0, start) + section + src.slice(end);
    } else {
      out = src.trimEnd() + "\n\n" + section + "\n";
    }
    atomicWrite(installed, out);
    foldedSkills++;
    foldedRules += promoted.length;
    summary.push(`${skill}: ${promoted.length} rule(s) folded (of ${clusters.length} clusters, journal ${findings.length})`);
  }

  atomicWrite(LAST_DISTILL, JSON.stringify({ at: new Date().toISOString(), journalLines: journal.length }));
  console.log(`distill: ${journal.length} findings → ${foldedRules} rule(s) across ${foldedSkills} skill(s)`);
  for (const s of summary) console.log(`  ${s}`);
}

// ---------- recall ----------
function recall() {
  const skill = flag("skill");
  if (!skill) die("recall requires --skill");
  const installed = join(INSTALLED_SKILLS, skill, "SKILL.md");

  if (existsSync(installed)) {
    const src = readFileSync(installed, "utf8");
    const start = src.indexOf(MARK_START);
    const end = src.indexOf(MARK_END);
    if (start >= 0 && end > start) {
      const body = src.slice(start + MARK_START.length, end).trim();
      if (body) {
        console.log(`learned rules (${skill}, machine-managed — promote to the shipped copy via PR):`);
        console.log(body);
      }
    }
  }

  const findings = readJournal().filter((f) => f.skill === skill).slice(-10);
  if (findings.length) {
    console.log(`\nrecent findings (${findings.length}, episodic):`);
    for (const f of findings) {
      console.log(`  [${f.at.slice(0, 10)}/${f.phase}] ${f.rule}${f.evidence ? ` — ${f.evidence}` : ""}`);
    }
  }
  if (!existsSync(installed) && !findings.length) console.log(`no memory yet for ${skill}`);
}

// ---------- stats ----------
function stats() {
  const journal = readJournal();
  const bySkill = {};
  const byPhase = {};
  for (const f of journal) {
    bySkill[f.skill] = (bySkill[f.skill] ?? 0) + 1;
    byPhase[f.phase] = (byPhase[f.phase] ?? 0) + 1;
  }
  console.log(`journal: ${journal.length} finding(s) at ${JOURNAL}`);
  console.log(`by skill: ${JSON.stringify(bySkill)}`);
  console.log(`by phase: ${JSON.stringify(byPhase)}`);
  if (existsSync(LAST_DISTILL)) {
    console.log(`last distill: ${readFileSync(LAST_DISTILL, "utf8")}`);
  }
}

switch (cmd) {
  case "record": record(); break;
  case "distill": distill(); break;
  case "recall": recall(); break;
  case "stats": stats(); break;
  default:
    die(`unknown command "${cmd ?? ""}" — use record | recall | distill | stats`);
}
