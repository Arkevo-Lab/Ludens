/** Pure documentation viewer DTOs shared by Console DocsView and Server query engine. */

export type DocLanguage = "en" | "zh";
export type DocGroup = "concepts" | "tutorials" | "reference" | "insights";

export interface DocEntry {
  id: string;
  title: string;
  group: DocGroup;
  path: string;
  lang: DocLanguage;
}

export interface DocHeading {
  id: string;
  text: string;
  level: number;
}

export interface DocCodeBlock {
  id: string;
  language: string;
  code: string;
}

export interface DocSummary {
  id: string;
  title: string;
  lang: DocLanguage;
  fallback: boolean;
  availableLanguages: DocLanguage[];
}

export interface DocGroupInfo {
  id: DocGroup;
  title: string;
  blurb: string;
  docs: DocSummary[];
}

export interface DocDetail {
  id: string;
  title: string;
  group: DocGroup;
  requestedLang: DocLanguage;
  lang: DocLanguage;
  fallback: boolean;
  html: string;
  headings: DocHeading[];
  codeBlocks: DocCodeBlock[];
}
