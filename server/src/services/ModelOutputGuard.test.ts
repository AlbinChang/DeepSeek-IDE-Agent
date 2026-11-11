import { describe, expect, it } from 'vitest';

import {
    buildCorruptionMessage,
    detectRepeatedControlToken,
    isModelMismatch,
    probeLeadingContent,
} from '@/services/ModelOutputGuard.js';

describe('probeLeadingContent', () => {
    it('flags ERNIE-style control tokens emitted as body text', () => {
        expect(probeLeadingContent('<|begin_of_sentence|>####下列判色丑')).toMatchObject({
            state: 'suspect',
            hit: { family: 'ernie' },
        });
        expect(probeLeadingContent('</begin_of_sentence /># exception; to')).toMatchObject({
            state: 'suspect',
            hit: { family: 'ernie' },
        });
    });

    it('flags DeepSeek and Qwen control tokens', () => {
        expect(probeLeadingContent('<｜begin▁of▁sentence｜>正文')).toMatchObject({
            state: 'suspect',
            hit: { family: 'deepseek' },
        });
        expect(probeLeadingContent('<|im_start|>assistant')).toMatchObject({
            state: 'suspect',
            hit: { family: 'qwen' },
        });
    });

    it('keeps buffering while the sample may still be a token prefix', () => {
        expect(probeLeadingContent('<|begin_of_').state).toBe('incomplete');
        expect(probeLeadingContent('   <').state).toBe('incomplete');
        expect(probeLeadingContent('').state).toBe('incomplete');
    });

    it('treats normal prose, headings and quoted tokens as clean', () => {
        expect(probeLeadingContent('### 结论\n模型工作正常')).toEqual({ state: 'clean' });
        expect(probeLeadingContent('下面列出文件：')).toEqual({ state: 'clean' });
        expect(probeLeadingContent('`<|begin_of_sentence|>` 是 ERNIE 的 BOS')).toEqual({ state: 'clean' });
        expect(probeLeadingContent('The < operator is smaller')).toEqual({ state: 'clean' });
    });
});

describe('detectRepeatedControlToken', () => {
    it('flags degenerate repetition of the same marker in short output', () => {
        const text = '开头 <|end_of_sentence|> 中间 <|end_of_sentence|> 结尾';
        expect(detectRepeatedControlToken(text)).toMatchObject({ family: 'ernie', count: 2 });
    });

    it('ignores a single quoted marker and long documents', () => {
        expect(detectRepeatedControlToken('BOS 是 <|end_of_sentence|> 的对称标记')).toBeUndefined();
        const long = `${'正常内容'.repeat(200)} <|end_of_sentence|> <|end_of_sentence|>`;
        expect(detectRepeatedControlToken(long)).toBeUndefined();
    });
});

describe('buildCorruptionMessage', () => {
    it('surfaces requested vs served model and endpoint for poisoning triage', () => {
        const message = buildCorruptionMessage(
            { token: '<|begin_of_sentence|>', family: 'ernie', count: 1 },
            'prefix',
            {
                requestedModel: 'deepseek-v4-flash',
                servedModels: ['ernie-4.5-300b-a47b'],
                baseUrlHost: 'gateway.example.com',
                systemFingerprints: ['fp-123'],
            },
        );
        expect(message).toContain('ERNIE/PaddleNLP');
        expect(message).toContain('请求模型：deepseek-v4-flash');
        expect(message).toContain('服务端回报模型：ernie-4.5-300b-a47b');
        expect(message).toContain('模型替换');
        expect(message).toContain('gateway.example.com');
        expect(message).toContain('fp-123');
    });

    it('treats versioned model ids as the same family', () => {
        expect(isModelMismatch('deepseek-chat', ['deepseek-chat-0324'])).toBe(false);
        expect(isModelMismatch('deepseek-chat', ['DeepSeek-Chat'])).toBe(false);
        expect(isModelMismatch('deepseek-v4-flash', ['ernie-4.5-300b-a47b'])).toBe(true);
        expect(isModelMismatch(undefined, ['ernie-4.5'])).toBe(false);
        expect(isModelMismatch('deepseek-chat', [])).toBe(false);
    });
});
