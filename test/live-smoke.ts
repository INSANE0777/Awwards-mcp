import { AwwwardsClient, RateLimiter } from "../src/awwwards.js";
import { parseListing, parseDetail } from "../src/parsers.js";

const client = new AwwwardsClient({ rateLimiter: new RateLimiter(1200) });

const listing = parseListing(await client.getHtml("/websites/"));
console.log("listing sites parsed:", listing.length);
if (listing.length < 10) throw new Error("parseListing returned too few sites");

const first = listing[0];
const details = parseDetail(await client.getHtml(first.detailPath), first.slug);
console.log("detail:", first.slug, "palette:", details.palette, "awards:", details.awards);
if (details.palette.length === 0) throw new Error("parseDetail returned no palette");

const thumb = await client.getThumbnail(first.thumbnailPath, 880);
console.log("thumbnail bytes:", thumb.length);
if (thumb.length < 10_000) throw new Error("thumbnail suspiciously small");

console.log("LIVE SMOKE OK");
