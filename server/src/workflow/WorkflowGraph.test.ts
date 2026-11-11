import { describe, expect, it } from 'vitest';

import { buildWorkflowGraph } from '@/workflow/WorkflowGraph.js';

describe('buildWorkflowGraph', () => {
    it('shows sequential, parallel and conditional workflow structure', () => {
        const graph = buildWorkflowGraph([
            { prepare: { set: { ready: true } } },
            { parallel: { fork: { branches: [
                { do: [{ left: { call: 'agent' } }] },
                { do: [{ right: { run: { shell: { command: 'test' } } } }] },
            ] } } },
            { choose: { switch: [
                { when: true, do: [{ yes: { set: { value: 1 } } }] },
                { default: { do: [{ no: { set: { value: 2 } } }] } },
            ] } },
        ]);
        expect(graph.mermaid).toContain('flowchart TD');
        expect(graph.mermaid).toContain('prepare : set');
        expect(graph.mermaid).toContain('branch 1');
        expect(graph.mermaid).toContain('branch 2');
        expect(graph.mermaid).toContain('left : call: agent');
        expect(graph.mermaid).toContain('right : run: shell');
        expect(graph.mermaid).toContain('default');
        expect(graph.truncated).toBe(false);
    });

    it('does not interpolate names as Mermaid directives', () => {
        const graph = buildWorkflowGraph([
            { 'x"] --> evil["oops': { call: 'agent' } },
        ]);
        expect(graph.mermaid).not.toContain(' --> evil');
        expect(graph.mermaid).not.toContain('oops"]');
        expect(graph.mermaid.split('\n')).toHaveLength(2);
    });

    it('limits graph size and reports truncation', () => {
        const graph = buildWorkflowGraph(
            Array.from({ length: 205 }, (_, index) => ({ [`step${index}`]: { set: { value: index } } })),
        );
        expect(graph.truncated).toBe(true);
        expect(graph.mermaid).toContain('step199');
        expect(graph.mermaid).not.toContain('step200');
    });
});
