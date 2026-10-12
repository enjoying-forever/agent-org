/**
 * What each model is good at, for the Role Market's model pages and the role designer: researched from the
 * makers' pages, benchmarks and reviews in October 2026 (each entry names its sources). Scores differ between
 * sources; the text says what most of them agree on, and a model's page shows where they come from.
 *
 * `ids`: the names a role may give it, on any program (Antigravity also runs Claude models, with the effort in
 * the name). Cost and speed are relative: $ cheap .. $$$$ the dearest; fast, medium, slow.
 */

export interface ModelGuide {
  id: string;
  name: string;
  maker: string;
  harness: string; // the program it is used through here
  ids: string[];
  cost: '$' | '$$' | '$$$' | '$$$$';
  speed: 'fast' | 'medium' | 'slow';
  summary: string; // one line
  good: string[];
  weak: string[];
  pick: string; // when to choose it
  roles: string[]; // ready-made roles that use it
  sources: [string, string][]; // [title, url]
}

export const RESEARCHED = '2026-10';

export const MODELS: ModelGuide[] = [
  {
    id: 'claude-fable-5-1', name: 'Claude Fable 5.1', maker: 'Anthropic', harness: 'claude', ids: ['fable', 'claude-fable-5-1'],
    cost: '$$$$', speed: 'slow',
    summary: "Anthropic's most capable model, for the longest and hardest work.",
    good: ['Long-horizon agentic work that runs for hours without losing the thread',
      'The hardest reasoning and coding problems (first on LiveCodeBench in one independent run)',
      'Open-ended design briefs: its predecessor won them in a 353-build frontend study'],
    weak: ['About 2.5 times the price of Opus 5.5 per token', 'Behind Opus and Sonnet 5.5 on terminal work (Terminal-Bench)'],
    pick: 'For an architect or a problem that Opus 5.5 at high effort still gets wrong. Start with Opus otherwise.',
    roles: ['architect'],
    sources: [['Anthropic: Claude Fable', 'https://www.anthropic.com/claude/fable'],
      ["Claude docs: what's new in Fable 5.1", 'https://platform.claude.com/docs/en/models/fable-5-1/whats-new-fable-5-1'],
      ['Vals AI: Fable 5.1 benchmarks', 'https://www.vals.ai/models/anthropic_claude-fable-5-1']],
  },
  {
    id: 'claude-opus-5-5', name: 'Claude Opus 5.5', maker: 'Anthropic', harness: 'claude',
    ids: ['opus', 'claude-opus-5-5', 'claude-opus-5-5-low', 'claude-opus-5-5-medium', 'claude-opus-5-5-high'],
    cost: '$$$', speed: 'medium',
    summary: 'The strongest all-rounder: hard coding, planning, review and interfaces.',
    good: ['The hardest coding and agent tasks; the highest agentic score of the Claude models in aggregate rankings',
      'Code review: clearly the stronger reviewer than Sonnet 5.5 in a review benchmark',
      'Frontend: first in a 353-build frontend study (80.2 at high effort), near the top of design arenas'],
    weak: ['Costs more per task than Sonnet 5.5, which comes close on everyday coding',
      'Slightly behind Sonnet 5.5 on terminal work (Terminal-Bench 4.0: 66.4% against 70.6%)'],
    pick: "Anthropic's recommended start for most work: a leader, a reviewer, a frontend developer.",
    roles: ['planner', 'reviewer', 'frontend'],
    sources: [['Anthropic: Sonnet 5.5 (with Opus 5.5 compared)', 'https://www.anthropic.com/claude-sonnet-5-5'],
      ['CodeRabbit: Sonnet 5.5 vs Opus 5.5 code review', 'https://www.coderabbit.ai/blog/sonnet-5-5-model-review'],
      ['BenchLM: Opus 5.5 vs Sonnet 5.5', 'https://benchlm.ai/compare/claude-opus-5-5-vs-claude-sonnet-5-5'],
      ['ModelGrep: best LLMs for design', 'https://modelgrep.com/best/design']],
  },
  {
    id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', maker: 'Anthropic', harness: 'claude',
    ids: ['sonnet', 'claude-sonnet-5-5', 'claude-sonnet-5-5-low', 'claude-sonnet-5-5-medium', 'claude-sonnet-5-5-high'],
    cost: '$$', speed: 'medium',
    summary: 'The agentic-coding workhorse: close to Opus for much less.',
    good: ['Terminal and command-line work: 70.6% on Terminal-Bench 4.0, above Opus 5.5',
      'Everyday coding within two or three points of Opus (FrontierCode, CursorBench)',
      'Up to about 30% cheaper per task than Opus 5.5'],
    weak: ['A weaker code reviewer than Opus 5.5', 'Behind Opus on the very hardest problems'],
    pick: 'For tests, builds and scripts, and most coding where Opus would be more than needed.',
    roles: ['tester', 'devops'],
    sources: [['Anthropic: Introducing Claude Sonnet 5.5', 'https://www.anthropic.com/claude-sonnet-5-5'],
      ['The Decoder: Sonnet 5.5 nearly matches Opus 5.5', 'https://the-decoder.com/anthropics-claude-sonnet-5-5-nearly-matches-opus-5-5-on-benchmarks-while-costing-up-to-30-percent-less-per-task/'],
      ['Vellum: Sonnet 5.5 benchmarks explained', 'https://www.vellum.ai/blog/claude-sonnet-5-5-benchmarks-explained']],
  },
  {
    id: 'gpt-6-astra', name: 'GPT-6 Astra', maker: 'OpenAI', harness: 'codex', ids: ['gpt-6-astra'],
    cost: '$$$$', speed: 'slow',
    summary: "OpenAI's top model, for the hardest jobs across many steps and tools.",
    good: ['The strongest OpenAI model across long chains of steps and tools',
      'Keeps notes across context windows in Codex, instead of squeezing a long session into one summary',
      'Frontend: 79.9 in a 353-build study, level with Opus 5.5'],
    weak: ['The dearest of the three ($10 / $50 per million tokens)', 'Slower and heavier than Sol'],
    pick: 'Only for what GPT-6.1 Sol cannot do. No ready-made role uses it: they start with Luna and Sol, which cost far less.',
    roles: [],
    sources: [['OpenAI: GPT-6 Astra', 'https://openai.com/index/gpt-6-astra/'],
      ['OpenAI: Codex models', 'https://developers.openai.com/codex/models'],
      ['DataCamp: GPT-6 Astra', 'https://www.datacamp.com/blog/gpt-6-astra']],
  },
  {
    id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', maker: 'OpenAI', harness: 'codex', ids: ['gpt-6.1-sol', 'gpt-6-sol'],
    cost: '$$', speed: 'medium',
    summary: "OpenAI's recommended model for complex coding: near Astra for a fifth of the price.",
    good: ['Complex coding and agentic work close to Astra', 'Work across code, apps and documents when cost matters',
      'Frontend: 78.6 in a 353-build study'],
    weak: ['Behind Astra on the very hardest multi-tool jobs', 'GPT-6 Sol (without .1) is the older version, at the same price'],
    pick: 'For a coder on features that touch many files, or a hard bug.',
    roles: ['senior-coder'],
    sources: [['OpenAI: Codex models', 'https://developers.openai.com/codex/models'],
      ['AIDEN: Codex models 2026 - Astra, Sol and Luna', 'https://aidenapp.org/codex-models']],
  },
  {
    id: 'gpt-6-luna', name: 'GPT-6 Luna', maker: 'OpenAI', harness: 'codex', ids: ['gpt-6-luna'],
    cost: '$', speed: 'fast',
    summary: 'The cheap, fast OpenAI model, for well-defined work done in volume.',
    good: ['Narrow tasks where a good result is clear: extraction, classification, transformation, structured summaries',
      'By far the cheapest of the three ($0.10 / $0.50 per million tokens)', 'Reasoning effort up to max'],
    weak: ['Open-ended or complex work, where Sol does much better', 'No ultra effort'],
    pick: 'For small, clear coding tasks, documentation and anything done many times.',
    roles: ['coder', 'docs-writer'],
    sources: [['OpenAI: Codex models', 'https://developers.openai.com/codex/models'],
      ['AIDEN: Codex models 2026 - Astra, Sol and Luna', 'https://aidenapp.org/codex-models']],
  },
  {
    id: 'gpt-5.6', name: 'GPT-5.6 Sol, Terra and Luna', maker: 'OpenAI', harness: 'codex',
    ids: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'], cost: '$', speed: 'fast',
    summary: 'The previous generation, still good for interfaces on a budget.',
    good: ['GPT-5.6 Sol led one live website arena for UI (1,415)',
      'GPT-5.6 Luna reached 88% of Fable 5 in a frontend study with 16% of the tokens'],
    weak: ['Behind the GPT-6 models on hard, long tasks'],
    pick: 'For cheap interface work when a GPT-6 model is not needed.',
    roles: [],
    sources: [['LLM Stats: best AI for UI design', 'https://llm-stats.com/best-ai-for-ui-design'],
      ['Startrise: best LLM for frontend', 'https://www.startrise.io/blog/best-llm-for-frontend/']],
  },
  {
    id: 'grok-4.7', name: 'Grok 4.7', maker: 'xAI', harness: 'grok', ids: ['grok-4.7', 'grok-4.6', 'grok-4.5'],
    cost: '$$', speed: 'slow',
    summary: "xAI's flagship: research and knowledge work, with the Grok family's live web and X search.",
    good: ['Research and knowledge work; leads the legal (Harvey) and electrical engineering (EEBench) tests xAI ran',
      "Live web and X search in the Grok family (not confirmed for 4.7 itself)", 'A 500K-token context; fewer hallucinations than 4.6 (29% against 34%)',
      'Coding agents: up nine points over 4.6 on an independent coding-agent index'],
    weak: ['Slow (about 40 tokens a second) and dear per task', 'Terminal work well below the makers\' figure on a neutral harness (about 26%)'],
    pick: 'For a researcher: current facts, libraries and sources.',
    roles: ['researcher'],
    sources: [['xAI: Introducing Grok 4.7', 'https://x.ai/news/grok-4-7'], ['xAI docs: Grok 4.7', 'https://docs.x.ai/developers/grok-4-7'],
      ['OpenTools: Grok 4.7 benchmarks and task cost', 'https://opentools.ai/news/grok-4-7-benchmarks-pricing-task-cost'],
      ['Lindy: Grok 4.7 - what changed', 'https://www.lindy.ai/blog/grok-4-7']],
  },
  {
    id: 'grok-4.7-build-fast', name: 'Grok 4.7 Fast', maker: 'xAI', harness: 'grok', ids: ['grok-4.7-build-fast'],
    cost: '$$$', speed: 'fast',
    summary: 'The same Grok 4.7, served about twice as fast at twice the price.',
    good: ['Interactive coding where waiting matters'], weak: ['Twice the token price; only in Grok Build and Cursor'],
    pick: 'When a Grok agent must answer quickly; otherwise Grok 4.7.',
    roles: [],
    sources: [['xAI docs: Grok 4.7', 'https://docs.x.ai/developers/grok-4-7'], ['eesel: Grok 4.7 review', 'https://www.eesel.ai/blog/grok-4-7-review']],
  },
  {
    id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', maker: 'Google', harness: 'antigravity',
    ids: ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low', 'gemini-3.7-flash-high',
      'gemini-3.7-flash-medium', 'gemini-3.7-flash-low', 'gemini-3.6-flash-high', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-low'],
    cost: '$', speed: 'fast',
    summary: "Google's fast agentic coder, very cheap, with strong video understanding.",
    good: ['Agentic workflows and coding: about 90% on Terminal-Bench 2.1 in Google\'s guide',
      'Very fast (about 300 tokens a second) and cheap ($0.75 / $3.75 per million tokens)',
      'Long video and images (LVBench 87.8%); a 1M-token context'],
    weak: ['Not near the top of the design and frontend arenas', 'Scores differ widely between sources'],
    pick: 'For a second coder on your Google plan, working beside the others. The effort is in its name.',
    roles: ['gemini-coder'],
    sources: [["Google: developer's guide to Gemini 3.8 Flash", 'https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-8-flash'],
      ['Vellum: Gemini 3.8 Flash benchmarks', 'https://www.vellum.ai/blog/gemini-3-8-flash-benchmarks-explained'],
      ['CodingFleet: Gemini 3.8 Flash review', 'https://codingfleet.com/blog/gemini-38-flash-review/']],
  },
  {
    id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', maker: 'Google', harness: 'antigravity', ids: ['gemini-3.1-pro-high', 'gemini-3.1-pro-low'],
    cost: '$$', speed: 'medium',
    summary: "Google's deep reasoner with the largest context: 2M tokens.",
    good: ['Deep reasoning on high-complexity questions', 'A 2M-token context: a large codebase or a stack of documents at once',
      'Text, images, audio and video in'],
    weak: ['Behind Gemini 3.8 Flash on coding in one aggregator', 'Slower and dearer than Flash'],
    pick: 'For an analyst who reads a whole codebase or long documents and answers questions about them.',
    roles: ['analyst'],
    sources: [["Google: developer's guide to Gemini 3.8 Flash (with 3.1 Pro)", 'https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-8-flash'],
      ['ModelSpectra: Gemini 3.1 Pro vs 3.8 Flash', 'https://modelspectra.com/compare/gemini-3-1-pro-vs-gemini-3-8-flash']],
  },
  {
    id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', maker: 'DeepSeek', harness: 'deepseek', ids: ['deepseek-v4-pro'],
    cost: '$$', speed: 'medium',
    summary: 'The careful DeepSeek coder: hard multi-step work, following instructions closely.',
    good: ['Hard, controlled multi-step coding; it keeps to instructions better than Flash',
      'LiveCodeBench 93.5 and SWE-bench Verified 80.6 (DeepSeek\'s own figures)', 'A 1M-token context'],
    weak: ['Behind Claude on SWE-bench Pro', 'Weakest in TypeScript in one study; code that looks right but fails'],
    pick: 'For hard coding on your DeepSeek account, beside the others.',
    roles: ['deepseek-pro-coder'],
    sources: [['DeepSeek-V4-Pro model card', 'https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro'],
      ['Codersera: DeepSeek V4 guide', 'https://codersera.com/blog/deepseek-v4-complete-guide-2026/']],
  },
  {
    id: 'deepseek-flash', name: 'DeepSeek Flash', maker: 'DeepSeek', harness: 'deepseek', ids: ['deepseek-flash'],
    cost: '$', speed: 'fast',
    summary: 'The fast, cheap DeepSeek model: twice the throughput of Pro.',
    good: ['More than twice the throughput of V4 Pro in one review', 'Competitive on many agentic coding tasks (strongest in V4.1)'],
    weak: ['Keeps less closely to instructions than Pro', 'Behind Pro on terminal work in DeepSeek\'s V4 figures'],
    pick: 'For quick, parallel coding on your DeepSeek account.',
    roles: ['deepseek-coder'],
    sources: [['DeepSeek-V4-Pro model card (Flash compared)', 'https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro'],
      ['AgentLens: coding agent trajectories', 'https://arxiv.org/pdf/2607.06624']],
  },
];

/** The guide for a model name a role gives (any program), or null for one not researched. */
export function guideFor(model: string): ModelGuide | null {
  const name = model.trim().toLowerCase();
  return MODELS.find((m) => m.ids.includes(name)) ?? null;
}
