import { createHandlerContext } from "./context.js";
import {
  search_sites,
  get_site_details,
  compare_sites,
  create_design_brief,
  get_site_elements,
  search_elements,
  get_element,
  list_categories,
} from "./handlers/awards.js";
import {
  capture_live_site,
  analyze_page_structure,
  analyze_hover_census,
  capture_pose_3d,
  capture_scene_3d,
  download_scene_assets,
  capture_component,
  export_design_tokens,
  analyze_images,
} from "./handlers/capture.js";
import {
  audit_url,
  analyze_accessibility,
  analyze_bundle,
  analyze_network_capture,
  verify_flow,
  verify_build,
} from "./handlers/audit.js";
import {
  build_pose_stub,
  build_scene_stub,
  analyze_stack,
  build_gsap_stub,
  build_motion_manifest,
  build_project,
} from "./handlers/build.js";
import {
  get_index_status,
  get_index_stats,
  get_annual_categories,
  get_annual_nominees,
  get_annual_nominee,
  get_collections,
  search_directory,
  new_winners,
  watch_site,
} from "./handlers/data.js";
import {
  analyze_scroll_map,
  record_site_motion,
  get_motion_dna,
  search_motion,
} from "./handlers/motion.js";
import {
  capture_atlas,
  export_evidence_pack,
  get_atlas,
  search_atlas,
} from "./handlers/atlas.js";
import type { CreateHandlersDeps, Handlers } from "./types.js";

/** Composes the full Handlers surface from the domain modules. */
export function createHandlers(deps: CreateHandlersDeps): Handlers {
  const ctx = createHandlerContext(deps);
  return {
    search_sites: (args) => search_sites(ctx, args),
    get_site_details: (args) => get_site_details(ctx, args),
    compare_sites: (args) => compare_sites(ctx, args),
    create_design_brief: (args) => create_design_brief(ctx, args),
    get_index_status: () => get_index_status(ctx),
    get_index_stats: (args) => get_index_stats(ctx, args),
    get_site_elements: (args) => get_site_elements(ctx, args),
    search_elements: (args) => search_elements(ctx, args),
    get_element: (args) => get_element(ctx, args),
    list_categories: () => list_categories(ctx),
    get_annual_categories: () => get_annual_categories(ctx),
    get_annual_nominees: (args) => get_annual_nominees(ctx, args),
    get_annual_nominee: (args) => get_annual_nominee(ctx, args),
    get_collections: (args) => get_collections(ctx, args),
    search_directory: (args) => search_directory(ctx, args),
    audit_url: (args) => audit_url(ctx, args),
    analyze_accessibility: (args) => analyze_accessibility(ctx, args),
    capture_live_site: (args) => capture_live_site(ctx, args),
    analyze_page_structure: (args) => analyze_page_structure(ctx, args),
    record_site_motion: (args) => record_site_motion(ctx, args),
    get_motion_dna: (args) => get_motion_dna(ctx, args),
    analyze_scroll_map: (args) => analyze_scroll_map(ctx, args),
    analyze_hover_census: (args) => analyze_hover_census(ctx, args),
    analyze_bundle: (args) => analyze_bundle(ctx, args),
    analyze_network_capture: (args) => analyze_network_capture(ctx, args),
    verify_flow: (args) => verify_flow(ctx, args),
    build_project: (args) => build_project(ctx, args),
    verify_build: (args) => verify_build(ctx, args),
    capture_component: (args) => capture_component(ctx, args),
    export_design_tokens: (args) => export_design_tokens(ctx, args),
    analyze_images: (args) => analyze_images(ctx, args),
    capture_pose_3d: (args) => capture_pose_3d(ctx, args),
    capture_scene_3d: (args) => capture_scene_3d(ctx, args),
    download_scene_assets: (args) => download_scene_assets(ctx, args),
    build_scene_stub: (args) => build_scene_stub(ctx, args),
    build_pose_stub: (args) => build_pose_stub(ctx, args),
    analyze_stack: (args) => analyze_stack(ctx, args),
    build_gsap_stub: (args) => build_gsap_stub(ctx, args),
    build_motion_manifest: (args) => build_motion_manifest(ctx, args),
    search_motion: (args) => search_motion(ctx, args),
    new_winners: (args) => new_winners(ctx, args),
    watch_site: (args) => watch_site(ctx, args),
    search_atlas: (args) => search_atlas(ctx, args),
    get_atlas: (args) => get_atlas(ctx, args),
    capture_atlas: (args, signal) => capture_atlas(ctx, args, signal),
    export_evidence_pack: (args) => export_evidence_pack(ctx, args),
  };
}
