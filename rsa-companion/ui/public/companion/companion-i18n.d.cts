interface CompanionCopy {
  lang: string;
  name: string;
  console: string;
  petLabel: string;
  petTitle: string;
  details: string;
  dismiss: string;
  dismissLabel: string;
  lines: string[];
  activity: Record<'running' | 'error' | 'complete' | 'generating' | 'content' | 'arguments' | 'result' | 'aiControl' | 'manualControl' | 'waiting' | 'returned', string>;
  menu: Record<'open' | 'quit' | 'play' | 'poses' | 'automatic' | 'effects' | 'none' | 'hide' | 'show' | 'size' | 'small' | 'medium' | 'large', string> & { categories: Record<string, string> };
  game: Record<'label' | 'target' | 'goal' | 'win' | 'lose' | 'score' | 'best', string>;
  assets: Record<string, string>;
}
declare const companionI18n: { en: CompanionCopy; zh: CompanionCopy };
export = companionI18n;
