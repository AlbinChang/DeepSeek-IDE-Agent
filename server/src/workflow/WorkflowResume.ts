import { workflowDefinitionHash } from '@/workflow/engineUtils.js';
import { WorkflowRegistry } from '@/workflow/WorkflowRegistry.js';
import type { WorkflowDefinition, WorkflowRunInfo } from '@/workflow/types.js';

export async function getResumeDefinitionError(
    root: string,
    run: WorkflowRunInfo,
    definition: WorkflowDefinition,
): Promise<string | undefined> {
    if (run.workflowDefinitionHash && run.workflowDefinitionHash !== workflowDefinitionHash(definition.yaml)) {
        return '工作流定义已修改，无法安全恢复此运行；请重新启动工作流';
    }

    const revisions = Object.entries(run.checkpoint?.definitionHashes ?? {});
    if (revisions.length === 0) return undefined;
    const registry = new WorkflowRegistry(root);
    const checked = await Promise.all(revisions.map(async ([workflowPath, expected]) => {
        const nested = await registry.loadDefinition(workflowPath);
        return { workflowPath, matches: Boolean(nested && workflowDefinitionHash(nested.yaml) === expected) };
    }));
    const changed = checked.find((entry) => !entry.matches);
    return changed ? `子工作流定义已修改或不可用，无法安全恢复: ${changed.workflowPath}` : undefined;
}
