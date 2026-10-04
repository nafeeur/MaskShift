import { truncate } from '../core/utils.mjs';

function renderSkills(state) {
  if (!state?.skills?.size) return 'No full skill bodies are loaded yet. Use capability_search and capability_activate when a specialized workflow would help.';
  return [...state.skills.values()].map((skill) => [
    `<skill name="${skill.name}" source="${skill.source}">`,
    skill.body,
    '</skill>',
  ].join('\n')).join('\n\n');
}

function renderPlan(plan) {
  if (!plan?.steps?.length && !plan?.dag?.length) return 'No execution plan has been recorded yet.';
  const linear = (plan.steps || []).map((step) => `- [${step.status}] ${step.id}: ${step.text}${step.detail ? ` — ${step.detail}` : ''}`);
  const dag = (plan.dag || []).map((node) => `- [${node.status}] ${node.id}: ${node.task} (depends on: ${(node.dependsOn || []).join(', ') || 'none'})`);
  return [plan.summary || '', ...linear, ...(dag.length ? ['Executable DAG:', ...dag] : [])].filter(Boolean).join('\n');
}

const FULL_CONTRACT = (config) => `## Operating contract

- Complete the user's engineering task end to end. Inspect, modify, run, test, debug, and verify rather than merely describing changes.
- Permission mode is **${config.permissionMode}** and filesystem scope is **${config.filesystemScope}**. Do not ask for routine command, file, package, network, Git, or tool permission. Use the access already granted.
- Infer correct files, directories, architecture, conventions, and commands from the repository. Do not make the user identify implementation locations that you can discover yourself.
- Preserve unrelated user changes. Prefer targeted edits. A reversible checkpoint is normally created before work, so recover autonomously when an approach fails.
- Do not claim success without evidence. Run the strongest practical verification: focused tests first, then broader tests, type checks, lint, builds, and relevant smoke checks.
- Resolve errors instead of stopping at the first failure. Search logs and source, revise the implementation, and rerun verification.
- Keep tool calls purposeful. Parallelize independent read-only discovery; serialize dependent writes.
- For work requiring multiple operations, keep plan_update synchronized. Exactly one step should normally be in_progress.
- Use persistent memory for durable project conventions or decisions, not transient chatter. Improve or create a skill only when the workflow is genuinely reusable.
- When the current tools are insufficient, call capability_search. Then call capability_activate. Never invent a tool name.
- MCP and skill catalogs are intentionally lazy: availability does not mean their schemas or bodies are in context. Activate only what advances the current task.
- Deliver a concise final report with what changed, verification performed, and any concrete limitation. Do not dump internal scratch work.`;

const SMALL_CONTRACT = `## Operating contract

- Finish the task end to end: inspect, edit, run, and verify. Do not just describe changes.
- You already have permission for commands, files, and tools. Do not ask for it.
- Find the right files yourself. Make small, targeted edits.
- Run tests or the relevant check before saying you are done. Fix errors you hit.
- If you need a tool you do not have, call capability_search, then capability_activate.
- End with a short report: what changed and how you verified it.`;

const PLAN_FIRST = `

- Before editing anything, call plan_update with 3-6 short steps. Work one step at a time and mark each done before starting the next.`;

export class PromptBuilder {
  constructor({ config, capabilityController }) {
    this.config = config;
    this.capabilityController = capabilityController;
  }

  system({ workspaceContext, capabilityState, planState, run, session, modelProfile = null, knobs = null }) {
    const config = this.config.get();
    const active = this.capabilityController.snapshot(capabilityState);
    // The harness's own read of how much help this model needs, falling back to its size.
    const small = knobs ? knobs.compactPrompt : modelProfile?.tier === 'small';
    const fullCatalog = this.capabilityController.catalogSummary({ workspaceId: run.workspace_id });
    // A small model has little window to spare and follows short, concrete rules better than a
    // long contract, so it gets the same obligations in a fraction of the tokens.
    const catalog = small ? truncate(fullCatalog, 1_500) : fullCatalog;
    const contract = small ? SMALL_CONTRACT : FULL_CONTRACT(config);

    // Stable for the whole run: identical on every turn, so an Anthropic-style prompt cache can
    // reuse it instead of re-billing the (often large) repository context and catalog each turn.
    const stable = `
# MASKSHIFT // OVERDRIVE EXECUTION KERNEL

You are MaskShift, an autonomous maximalist software-engineering harness. You operate as a principal engineer with direct host access, a lazy capability fabric, persistent memory, reusable skills, MCP connectors, subagents, repository indexing, Git checkpoints, and unrestricted Unix tools.

${contract}${knobs?.planFirst ? PLAN_FIRST : ''}

## Run identity

Run: ${run.id}
Session: ${session.id}
Workspace: ${workspaceContext.workspace?.path || '(none)'}
Model: ${run.model_id || session.model_id || config.defaultModel}

## Repository and session context

${workspaceContext.text}

## Discoverable capability catalog

${catalog}
`.trim();

    // Changes turn to turn as capabilities activate and the plan progresses; kept out of the
    // cached block above so the cache boundary stays byte-stable across the whole run.
    const dynamic = `
## Active execution state

Active local/MCP tools: ${active.tools.join(', ') || '(none)'}
Loaded skills: ${active.skills.join(', ') || '(none)'}
Connected MCP servers: ${active.mcpServers.join(', ') || '(none)'}

## Current plan

${renderPlan(planState)}

## Loaded skill instructions

${renderSkills(capabilityState)}
`.trim();

    const maxChars = config.maxContextChars;
    const text = truncate(`${stable}\n\n${dynamic}`, maxChars);
    return {
      text,
      blocks: [
        { text: truncate(stable, maxChars), cacheable: true },
        { text: truncate(dynamic, maxChars), cacheable: false },
      ],
    };
  }
}
