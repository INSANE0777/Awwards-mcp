export interface SiteSummary {
  id: number;
  slug: string;
  title: string;
  createdAt: number; // unix seconds
  tags: string[];
  thumbnailPath: string; // e.g. "submissions/2026/08/xxx.jpg"
  liveUrl: string | null;
  detailPath: string; // e.g. "/sites/l-i-s-a"
  awards: string[]; // e.g. ["Site of the Day", "Developer Award"]
}

export interface SiteDetails {
  slug: string;
  title: string | null;
  description: string | null; // curated ">Description</h2>" section; og:description meta as fallback
  palette: string[]; // hex codes, uppercase, e.g. "#000000"
  technologies: string[];
  elements: string[];
  awards: { title: string; date: string }[];
  score: number | null; // displayed overall jury score, null when absent
  // Per-dimension jury scores from the layout-overall chartbar block
  // (Design / Usability / Creativity / Content). Undefined when the page has
  // no jury chartbar or the dimension labels drifted from the known four.
  juryDimensions?: {
    design: number;
    usability: number;
    creativity: number;
    content: number;
  };
  ogImage: string | null;
  liveUrl: string | null;
}

export interface Categories {
  colors: string[]; // hex codes, uppercase
  filters: string[]; // tag/technology slugs, e.g. "3d", "webgl"
}

export interface ElementMedia {
  title: string;
  mediaPath: string; // e.g. "element/2026/08/<hash>.mp4" or ".jpg"
}
