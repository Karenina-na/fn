import type { ToolDefinition } from '../tool/tool.ts';

export interface PromptSpec {
  intro: string;
  role?: string[];
  instructionScope?: string[];
  scopeAndSafety?: string[];
  untrustedDataHandling?: string[];
  sourcePriority?: string[];
  knowledgeBoundaries?: string[];
  toolUse?: string[];
  memoryUse?: string[];
  style?: string[];
  uncertaintyAndErrors?: string[];
  outputContract?: string[];
}

export function buildPrompt(spec: PromptSpec, tools: ToolDefinition[]): string {
  const sections: string[] = [];
  if (spec.intro.trim()) sections.push(spec.intro.trim());
  const section = (title: string, items?: string[], ordered = false) => {
    const clean = items?.map(item => item.trim()).filter(Boolean) ?? [];
    if (clean.length) sections.push(`${title}\n${clean.map((item, index) => `${ordered ? `${index + 1}.` : '-'} ${item}`).join('\n')}`);
  };
  section('ROLE', spec.role);
  section('INSTRUCTION SCOPE', spec.instructionScope);
  section('SCOPE AND SAFETY', spec.scopeAndSafety);
  section('UNTRUSTED DATA HANDLING', spec.untrustedDataHandling);
  section('SOURCE PRIORITY', spec.sourcePriority, true);
  section('KNOWLEDGE BOUNDARIES', spec.knowledgeBoundaries);
  section('TOOL USE', spec.toolUse);
  section('MEMORY USE', spec.memoryUse);
  if (tools.length) sections.push(`AVAILABLE TOOLS\n- The following registered tools are available for this run.\n${tools.map(tool => `- ${tool.name} [${tool.effect.replaceAll('_', '-')}]: ${tool.description}\n  Guidance: ${tool.usage}`).join('\n')}`);
  if (sections.length || tools.length) {
    const boundaries = ['CAPABILITY BOUNDARIES', '- Only registered tools are available for this run.'];
    if (!tools.length) boundaries.push('- No tools are registered for this run.');
    else boundaries.push('- Each tool may act only within its declared effect and scope.', '- A tool’s existence does not grant capabilities beyond its declared effect.', '- Read-only tools do not change state; session-write tools may change only temporary state bound to the current session.');
    if (tools.some(tool => tool.effect === 'write' || tool.effect === 'destructive')) boundaries.push('- Persistent-write and destructive tools are unavailable without an explicit runtime grant; destructive operations also require confirmation.');
    sections.push(boundaries.join('\n'));
  }
  section('STYLE', spec.style);
  section('UNCERTAINTY AND ERRORS', spec.uncertaintyAndErrors);
  section('OUTPUT CONTRACT', spec.outputContract);
  return sections.join('\n\n');
}
