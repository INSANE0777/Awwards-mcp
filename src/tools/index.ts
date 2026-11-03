import type { ToolContext } from "./shared.js";
import {
  registerSearchSites,
  registerGetSiteDetails,
  registerCompareSites,
  registerCreateDesignBrief,
  registerGetIndexStatus,
  registerGetIndexStats,
  registerGetSiteElements,
  registerSearchElements,
  registerGetElement,
  registerListCategories,
  registerGetAnnualCategories,
  registerGetAnnualNominees,
  registerGetAnnualNominee,
  registerGetCollections,
  registerSearchDirectory,
  registerNewWinners,
  registerWatchSite,
} from "./awards.js";
import {
  registerCaptureLiveSite,
  registerAnalyzePageStructure,
  registerAnalyzeScrollMap,
  registerAnalyzeHoverCensus,
  registerCaptureComponent,
  registerExportDesignTokens,
  registerAnalyzeImages,
  registerCapturePose3d,
  registerRecordSiteMotion,
} from "./capture.js";
import {
  registerAuditUrl,
  registerAnalyzeAccessibility,
  registerAnalyzeBundle,
  registerAnalyzeNetworkCapture,
  registerVerifyFlow,
  registerVerifyBuild,
} from "./audit.js";
import {
  registerBuildProject,
  registerBuildPoseStub,
  registerBuildGsapStub,
  registerBuildMotionManifest,
  registerBuildSceneStub,
  registerAnalyzeStack,
  registerGetMotionDna,
  registerSearchMotion,
} from "./build.js";
import { registerCaptureScene3d } from "./scene.js";

/** Registers the full MCP tool surface in its stable, historical order. */
export function registerAllTools(ctx: ToolContext): void {
  registerSearchSites(ctx);
  registerGetSiteDetails(ctx);
  registerCompareSites(ctx);
  registerCreateDesignBrief(ctx);
  registerGetIndexStatus(ctx);
  registerGetIndexStats(ctx);
  registerGetSiteElements(ctx);
  registerSearchElements(ctx);
  registerGetElement(ctx);
  registerListCategories(ctx);
  registerGetAnnualCategories(ctx);
  registerGetAnnualNominees(ctx);
  registerGetAnnualNominee(ctx);
  registerGetCollections(ctx);
  registerSearchDirectory(ctx);
  registerAuditUrl(ctx);
  registerAnalyzeAccessibility(ctx);
  registerCaptureLiveSite(ctx);
  registerAnalyzePageStructure(ctx);
  registerRecordSiteMotion(ctx);
  registerGetMotionDna(ctx);
  registerAnalyzeScrollMap(ctx);
  registerAnalyzeHoverCensus(ctx);
  registerAnalyzeBundle(ctx);
  registerAnalyzeNetworkCapture(ctx);
  registerVerifyFlow(ctx);
  registerBuildProject(ctx);
  registerVerifyBuild(ctx);
  registerCaptureComponent(ctx);
  registerExportDesignTokens(ctx);
  registerAnalyzeImages(ctx);
  registerCapturePose3d(ctx);
  registerCaptureScene3d(ctx);
  registerBuildPoseStub(ctx);
  registerAnalyzeStack(ctx);
  registerBuildGsapStub(ctx);
  registerBuildMotionManifest(ctx);
  registerBuildSceneStub(ctx);
  registerSearchMotion(ctx);
  registerNewWinners(ctx);
  registerWatchSite(ctx);
}
