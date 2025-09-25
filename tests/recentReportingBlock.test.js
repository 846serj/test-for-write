import assert from 'assert';
import fs from 'fs';
import * as ts from 'typescript';
import { test } from 'node:test';

const routePath = new URL('../src/app/api/generate/route.ts', import.meta.url);
const tsCode = fs.readFileSync(routePath, 'utf8');

const detailInstructionMatch = tsCode.match(/const DETAIL_INSTRUCTION[\s\S]*?';/);
const detailExtractionMatch = tsCode.match(
  /const TIMELINE_REGEX[\s\S]*?function formatKeyDetails[\s\S]*?\n\}/
);
const formatPublishedMatch = tsCode.match(/function formatPublishedTimestamp[\s\S]*?\n\}/);
const normalizeSummaryMatch = tsCode.match(/function normalizeSummary[\s\S]*?\n\}/);
const buildBlockMatch = tsCode.match(/function buildRecentReportingBlock[\s\S]*?\n\}/);

if (
  !detailInstructionMatch ||
  !detailExtractionMatch ||
  !formatPublishedMatch ||
  !normalizeSummaryMatch ||
  !buildBlockMatch
) {
  throw new Error('Failed to extract helper definitions from route.ts');
}

async function transpile(snippet) {
  const jsCode = ts.transpileModule(snippet, {
    compilerOptions: { module: ts.ModuleKind.ESNext },
  }).outputText;
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(jsCode).toString('base64');
  try {
    return await import(moduleUrl);
  } catch (err) {
    if (err && typeof err.message === 'string') {
      err.message += `\nGenerated code:\n${jsCode}`;
    }
    throw err;
  }
}

function extractPromptSnippet(startMarker) {
  const start = tsCode.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`Unable to locate marker: ${startMarker}`);
  }
  const reportingStart = tsCode.indexOf('const reportingSection', start);
  if (reportingStart === -1) {
    throw new Error(`Unable to locate reporting section for marker: ${startMarker}`);
  }
  const trimIndex = tsCode.indexOf('`.trim();', reportingStart);
  if (trimIndex === -1) {
    throw new Error(`Unable to locate prompt terminator for marker: ${startMarker}`);
  }
  return tsCode.slice(reportingStart, trimIndex + '`.trim();'.length);
}

const reportingHelpers = `
${detailInstructionMatch[0]}
${detailExtractionMatch[0]}
${formatPublishedMatch[0]}
${normalizeSummaryMatch[0]}
${buildBlockMatch[0]}
`;

test('buildRecentReportingBlock formats entries with timestamps and fallbacks', async () => {
  const snippet = `
${reportingHelpers}
const items = [
  { title: 'Alpha', summary: ' First summary ', url: 'https://alpha.test', publishedAt: '2024-05-01T12:00:00Z' },
  { title: '', summary: '', url: 'https://beta.test', publishedAt: 'invalid-date' },
];
const block = buildRecentReportingBlock(items);
export { block };
`;
  const { block } = await transpile(snippet);
  assert(block.includes('Recent reporting to reference:'));
  assert(block.includes('"Alpha" (2024-05-01T12:00:00.000Z)'));
  assert(block.includes('Summary: First summary'));
  assert(block.includes('URL: https://alpha.test'));
  assert(block.includes('"Untitled" (Unknown publication time)'));
  assert(block.includes('Summary: No summary provided.'));
  assert.strictEqual(block.includes('Key details:'), false);
});

test('formatKeyDetails surfaces metrics, timelines, methods, and entities', async () => {
  const snippet = `
${reportingHelpers}
const summary = 'Pfizer reported 72% efficacy in a 1,500-person randomized controlled trial completed on March 3, 2024.';
const details = formatKeyDetails(summary);
export { details };
`;
  const { details } = await transpile(snippet);
  assert(details.includes('Cite these metrics verbatim: 72%, 1,500-person'));
  assert(details.includes('State these reported timelines exactly: March 3, 2024'));
  assert(details.includes('Reference the research methods noted: randomized controlled trial'));
  assert(details.includes('Name these entities precisely: Pfizer'));
});

test('listicle prompt injects reporting block and grounding instruction', async () => {
  const promptSnippet = extractPromptSnippet("if (articleType === 'Listicle/Gallery')");
  const snippet = `
${reportingHelpers}
const reportingSources = [
  {
    title: 'Sample Investigation',
    summary: 'Key developments about the topic.',
    url: 'https://news.test/sample',
    publishedAt: '2024-07-04T10:00:00Z',
  },
];
const reportingBlock = buildRecentReportingBlock(reportingSources);
const groundingInstruction = reportingSources.length
  ? '- Base every factual statement on the reporting summaries provided and cite the matching URL when referencing them.\\n'
  : '';
const linkInstruction = '';
const title = 'Test Listicle';
const outline = 'INTRO:\\n- Opening\\n\\n1. Heading';
const lengthInstruction = '- Use exactly 3 items.\\n';
const numberingInstruction = '';
const wordCountInstruction = '';
const customInstructionBlock = '';
const toneInstruction = '';
const povInstruction = '';
${promptSnippet}
export { articlePrompt, reportingBlock, groundingInstruction };
`;
  const { articlePrompt, reportingBlock, groundingInstruction } = await transpile(snippet);
  assert(articlePrompt.includes('Recent reporting to reference:'));
  assert(articlePrompt.includes('Key developments about the topic.'));
  assert(articlePrompt.includes('https://news.test/sample'));
  assert(articlePrompt.includes('Base every factual statement on the reporting summaries provided and cite the matching URL'));
  assert.strictEqual(reportingBlock.trim().startsWith('Recent reporting to reference:'), true);
  assert.strictEqual(groundingInstruction.includes('cite the matching URL'), true);
});

test('YouTube prompt injects reporting block and grounding instruction', async () => {
  const promptSnippet = extractPromptSnippet("if (articleType === 'YouTube video to blog post')");
  const snippet = `
${reportingHelpers}
const reportingSources = [
  {
    title: 'Video Analysis',
    summary: 'Highlights from investigative reporters.',
    url: 'https://news.test/video',
    publishedAt: '2024-07-05T15:30:00Z',
  },
];
const reportingBlock = buildRecentReportingBlock(reportingSources);
const groundingInstruction = reportingSources.length
  ? '- Base every factual statement on the reporting summaries provided and cite the matching URL when referencing them.\\n'
  : '';
const linkInstruction = '';
const transcriptInstruction = '';
const toneInstruction = '';
const povInstruction = '';
const title = 'Video to Blog';
const customInstructionBlock = '';
${promptSnippet}
export { articlePrompt };
`;
  const { articlePrompt } = await transpile(snippet);
  assert(articlePrompt.includes('Recent reporting to reference:'));
  assert(articlePrompt.includes('https://news.test/video'));
  assert(articlePrompt.includes('cite the matching URL'));
});

test('rewrite prompt injects reporting block and grounding instruction', async () => {
  const promptSnippet = extractPromptSnippet("if (articleType === 'Rewrite blog post')");
  const snippet = `
${reportingHelpers}
const reportingSources = [
  {
    title: 'Blog Rewrite Source',
    summary: 'Important details to incorporate.',
    url: 'https://news.test/rewrite',
    publishedAt: '2024-07-06T08:45:00Z',
  },
];
const reportingBlock = buildRecentReportingBlock(reportingSources);
const groundingInstruction = reportingSources.length
  ? '- Base every factual statement on the reporting summaries provided and cite the matching URL when referencing them.\\n'
  : '';
const linkInstruction = '';
const rewriteInstruction = '';
const toneInstruction = '';
const povInstruction = '';
const title = 'Rewrite Blog';
const lengthInstruction = '- Use exactly 3 sections.\\n';
const customInstructionBlock = '';
const lengthOption = 'default';
const customSections = 0;
const WORD_RANGES = {};
const sectionRanges = {};
const DEFAULT_WORDS = 900;
${promptSnippet}
export { articlePrompt };
`;
  const { articlePrompt } = await transpile(snippet);
  assert(articlePrompt.includes('Recent reporting to reference:'));
  assert(articlePrompt.includes('https://news.test/rewrite'));
  assert(articlePrompt.includes('cite the matching URL'));
});

test('blog prompt injects reporting block and grounding instruction', async () => {
  const promptSnippet = extractPromptSnippet('// ─── Blog post (default) ───────────────────────────────────────────────────');
  const snippet = `
${reportingHelpers}
const reportingSources = [
  {
    title: 'Blog Source',
    summary: 'Background research summary.',
    url: 'https://news.test/blog',
    publishedAt: '2024-07-07T11:20:00Z',
  },
];
const reportingBlock = buildRecentReportingBlock(reportingSources);
const groundingInstruction = reportingSources.length
  ? '- Base every factual statement on the reporting summaries provided and cite the matching URL when referencing them.\\n'
  : '';
const linkInstruction = '';
const toneInstruction = '';
const povInstruction = '';
const title = 'Default Blog';
const outline = 'INTRO:\\n- Opening\\n\\n<h2>Section</h2>';
const lengthInstruction = '- Aim for around 9 sections.\\n';
const customInstructionBlock = '';
const lengthOption = 'default';
const customSections = 0;
const WORD_RANGES = {};
const sectionRanges = {};
const DEFAULT_WORDS = 900;
${promptSnippet}
export { articlePrompt };
`;
  const { articlePrompt } = await transpile(snippet);
  assert(articlePrompt.includes('Recent reporting to reference:'));
  assert(articlePrompt.includes('https://news.test/blog'));
  assert(articlePrompt.includes('cite the matching URL'));
});
