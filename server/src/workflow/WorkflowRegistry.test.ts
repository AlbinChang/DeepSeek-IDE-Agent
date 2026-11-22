import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorkflowRegistry } from '@/workflow/WorkflowRegistry.js';
import { PROJECT_ROOT } from '@/utils/PathUtils.js';

const validWorkflow = `document:
  dsl: 1.0.0
  namespace: deepseek-ide
  name: feature-delivery
  version: 1.0.0
  title: 需求实现与评估
  summary: 分析、实现并评估
  input:
    schema:
      type: object
      required: [requirement]
      properties:
        requirement:
          type: string
          description: 用户需求
        branch:
          type: string
          default: main
do:
  - plan:
      call: agent
      with:
        prompt: "Plan: \${ .inputs.requirement }"
  - implement:
      call: agent
      with:
        prompt: "Implement"
`;

describe('WorkflowRegistry', () => {
    let root: string;

    beforeEach(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'workflow-registry-'));
        await mkdir(path.join(root, '.workflow'), { recursive: true });
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('lists workflow metadata from .workflow', async () => {
        await writeFile(path.join(root, '.workflow', 'feature-delivery.yaml'), validWorkflow, 'utf8');

        const workflows = await new WorkflowRegistry(root).list();

        expect(workflows).toHaveLength(1);
        expect(workflows[0]).toMatchObject({
            name: 'feature-delivery',
            path: '.workflow/feature-delivery.yaml',
            title: '需求实现与评估',
            version: '1.0.0',
            namespace: 'deepseek-ide',
            stepCount: 2,
        });
        expect(workflows[0].inputs).toEqual([
            { name: 'requirement', type: 'string', description: '用户需求', required: true, default: undefined },
            { name: 'branch', type: 'string', description: undefined, required: false, default: 'main' },
        ]);
    });

    it('returns detail with a successful built-in validation', async () => {
        await writeFile(path.join(root, '.workflow', 'feature-delivery.yaml'), validWorkflow, 'utf8');

        const detail = await new WorkflowRegistry(root).get('feature-delivery');

        expect(detail).not.toBeNull();
        expect(detail!.validation.ok).toBe(true);
        expect(detail!.validation.issues).toEqual([]);
        expect(detail!.yaml).toContain('feature-delivery');
    });

    it('reports YAML parse failures without throwing', async () => {
        await writeFile(path.join(root, '.workflow', 'broken.yaml'), 'document: [unclosed', 'utf8');

        const detail = await new WorkflowRegistry(root).get('broken');

        expect(detail).not.toBeNull();
        expect(detail!.validation.ok).toBe(false);
        expect(detail!.validation.issues[0].severity).toBe('error');
        expect(detail!.validation.issues[0].message).toContain('YAML 解析失败');
    });

    it('rejects a workflow without do steps', async () => {
        await writeFile(path.join(root, '.workflow', 'empty.yaml'), 'document:\n  dsl: 1.0.0\n  name: empty\n', 'utf8');

        const detail = await new WorkflowRegistry(root).get('empty');

        expect(detail!.validation.ok).toBe(false);
        expect(detail!.validation.issues.some((issue) => issue.path === '/do')).toBe(true);
    });

    it('supports nested files and lookup by document name', async () => {
        await mkdir(path.join(root, '.workflow', 'team'), { recursive: true });
        await writeFile(path.join(root, '.workflow', 'team', 'nested.yaml'), validWorkflow, 'utf8');

        const registry = new WorkflowRegistry(root);
        const byName = await registry.get('feature-delivery');
        const byPath = await registry.get('team/nested.yaml');

        expect(byName?.summary.path).toBe('.workflow/team/nested.yaml');
        expect(byPath?.summary.name).toBe('feature-delivery');
        expect((await registry.list())[0].path).toBe('.workflow/team/nested.yaml');
    });

    it('keeps reserved asset directories out of workflow discovery', async () => {
        await mkdir(path.join(root, '.workflow', 'tools'), { recursive: true });
        await mkdir(path.join(root, '.workflow', 'assets'), { recursive: true });
        await writeFile(path.join(root, '.workflow', 'tools', 'helper.yaml'), validWorkflow, 'utf8');
        await writeFile(path.join(root, '.workflow', 'assets', 'template.yaml'), validWorkflow, 'utf8');
        await writeFile(path.join(root, '.workflow', 'feature-delivery.yaml'), validWorkflow, 'utf8');

        const workflows = await new WorkflowRegistry(root).list();

        expect(workflows.map((workflow) => workflow.path)).toEqual(['.workflow/feature-delivery.yaml']);
    });

    it('warns when shell steps reference workspace-root tools or scripts', async () => {
        await writeFile(path.join(root, '.workflow', 'root-assets.yaml'), `document:
  dsl: 1.0.0
  name: root-assets
do:
  - legacy:
      run:
        shell:
          command: python tools/stockvalue/collect.py
  - preferred:
      run:
        shell:
          command: python .workflow/tools/stockvalue/collect.py
  - backslash:
      call: shell
      with:
        command: python .\\scripts\\collect.py
`, 'utf8');

        const detail = await new WorkflowRegistry(root).get('root-assets');
        const warnings = detail!.validation.issues.filter((issue) => issue.severity === 'warning');

        expect(detail!.validation.ok).toBe(true);
        expect(warnings.map((warning) => warning.path)).toEqual([
            '/do/0/legacy/run/shell/command',
            '/do/2/backslash/with/command',
        ]);
    });

    it('validates step-level when, continueOnError and acceptedExitCodes', async () => {
        await writeFile(path.join(root, '.workflow', 'conditional.yaml'), `document:
  dsl: 1.0.0
  name: conditional
do:
  - optional:
      when: \${ .inputs.enabled == true }
      continueOnError: "yes"
      run:
        shell:
          command: exit 4
          acceptedExitCodes: [0, "4"]
`, 'utf8');

        const detail = await new WorkflowRegistry(root).get('conditional');

        expect(detail!.validation.ok).toBe(false);
        expect(detail!.validation.issues).toEqual(expect.arrayContaining([
            expect.objectContaining({ path: '/do/0/optional/continueOnError', severity: 'error' }),
            expect.objectContaining({ path: '/do/0/optional/run/shell/acceptedExitCodes', severity: 'error' }),
        ]));
    });

    it('validates nested control-flow steps recursively', async () => {
        await writeFile(path.join(root, '.workflow', 'nested-invalid.yaml'), `document:
  dsl: 1.0.0
  name: nested-invalid
do:
  - choose:
      switch:
        - when: { invalid: true }
          do:
            - bad:
                continueOnError: "no"
`, 'utf8');

        const detail = await new WorkflowRegistry(root).get('nested-invalid');

        expect(detail!.validation.ok).toBe(false);
        expect(detail!.validation.issues).toEqual(expect.arrayContaining([
            expect.objectContaining({ path: '/do/0/choose/switch/case-0/when', severity: 'error' }),
            expect.objectContaining({
                path: '/do/0/choose/switch/case-0/do/0/bad/continueOnError',
                severity: 'error',
            }),
        ]));
    });

    it('rejects path traversal attempts', async () => {
        const registry = new WorkflowRegistry(root);
        await expect(registry.get('../secret')).rejects.toThrow('Invalid workflow path');
        await expect(registry.get('.workflow/../secret.yaml')).rejects.toThrow('Invalid workflow path');
    });

    it('discovers the canonical *.workflow.yaml layout', async () => {
        await writeFile(path.join(root, '.workflow', 'demo.workflow.yaml'), validWorkflow, 'utf8');

        const registry = new WorkflowRegistry(root);
        const byName = await registry.get('demo');
        const definition = await registry.loadDefinition('demo');

        expect(byName?.summary.name).toBe('feature-delivery');
        expect(byName?.summary.path).toBe('.workflow/demo.workflow.yaml');
        expect(definition?.steps).toHaveLength(2);
        expect(definition?.steps[0]).toHaveProperty('plan');
    });

    it('validates all workflows when no target is provided', async () => {
        await writeFile(path.join(root, '.workflow', 'good.yaml'), validWorkflow, 'utf8');
        await writeFile(path.join(root, '.workflow', 'bad.yaml'), 'document:\n  name: bad\ndo: []\n', 'utf8');

        const result = await new WorkflowRegistry(root).validate();

        expect(result.ok).toBe(false);
        expect(result.issues).toEqual(expect.arrayContaining([
            expect.objectContaining({ path: '.workflow/bad.yaml/do', severity: 'error' }),
        ]));
        expect(result.issues.every((issue) => !issue.path.startsWith('.workflow/good.yaml'))).toBe(true);
    });

    it('deep-compiles subworkflows and .workflow assets', async () => {
        await writeFile(path.join(root, '.workflow', 'child.yaml'), `document:
  dsl: 1.0.0
  name: child
  input:
    schema:
      properties:
        text: { type: string }
do:
  - note:
      set:
        note: "\${ .inputs.text }"
`, 'utf8');
        await writeFile(path.join(root, '.workflow', 'parent.yaml'), `document:
  dsl: 1.0.0
  name: parent
do:
  - childStep:
      call: workflow
      with:
        name: child
  - run:
      run:
        shell:
          command: pwsh -File .workflow/tools/check.ps1
`, 'utf8');

        const missing = await new WorkflowRegistry(root, { deep: true }).validate('parent');
        expect(missing.ok).toBe(false);
        expect(missing.issues.map((issue) => issue.code)).toEqual(['asset_missing']);
        expect(missing.issues[0].path).toContain('/do/1/run');

        await mkdir(path.join(root, '.workflow', 'tools'), { recursive: true });
        await writeFile(path.join(root, '.workflow', 'tools', 'check.ps1'), '# ok', 'utf8');

        const settled = await new WorkflowRegistry(root, { deep: true }).validate('parent');
        expect(settled.ok).toBe(true);
        expect(settled.issues).toEqual([]);
    });

    it('links with.tools against registered tool names', async () => {
        await writeFile(path.join(root, '.workflow', 'tools-check.yaml'), `document:
  dsl: 1.0.0
  name: tools-check
do:
  - agent:
      call: agent
      with:
        prompt: hi
        tools: [read_file, typo_tool]
  - tool:
      call: tool
      with:
        tool: also_missing
`, 'utf8');

        const registry = new WorkflowRegistry(root, { knownTools: ['read_file'] });
        const result = await registry.validate('tools-check');
        const codes = result.issues.map((issue) => issue.code);
        expect(codes.filter((code) => code === 'tool_unknown')).toHaveLength(2);
        expect(result.ok).toBe(true); // 链接问题按 warning 处理
    });

    it('validates the bundled *.workflow.yaml examples', async () => {
        const registry = new WorkflowRegistry(PROJECT_ROOT);
        const workflows = await registry.list();
        const names = workflows.map((workflow) => workflow.name);

        expect(names).toEqual(expect.arrayContaining(['hello', 'approval-demo', 'workspace-review']));
        const validation = await registry.validate();
        expect(validation.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    });
});
