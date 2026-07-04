/**
 * typescriptProgramCheck.worker — TypeScript 项目级类型检查 Worker
 *
 * 背景：
 * SyntaxCheckService 的写后语法门禁会对 .ts/.tsx 文件做“项目级类型检查”
 * （ts.createProgram + getPreEmitDiagnostics，等价于 tsc --noEmit）。这是
 * CPU 密集型同步计算，若直接在主线程执行，会阻塞 Electron 主进程 / Node
 * 主事件循环（IPC、终端输出转发、其他文件操作都会被卡住）。
 *
 * 本文件故意使用纯 JavaScript（.mjs）而非 TypeScript：
 * - worker_threads 生成的子线程需要独立的模块加载器；用纯 JS 可以在
 *   dev（tsx watch）、生产（tsc 编译产物）、Electron 主进程内嵌运行三种
 *   场景下被 Node 直接加载，无需处理 tsx/ts-node 的 loader hook 传递问题。
 * - 生产构建时，server/package.json 的 postbuild 脚本会把 src/workers
 *   原样拷贝到 dist/workers（与 src/config → dist/config 的既有做法一致）。
 */
import { parentPort } from 'node:worker_threads';
import * as path from 'node:path';

if (!parentPort) {
    throw new Error('typescriptProgramCheck.worker 必须在 worker_threads 环境下运行');
}

parentPort.on('message', async (msg) => {
    const requestId = msg && msg.requestId;
    const fullPath = msg && msg.fullPath;
    try {
        const result = await runCheck(fullPath);
        parentPort.postMessage({ requestId, ...result });
    } catch (err) {
        parentPort.postMessage({
            requestId,
            ok: false,
            error: (err && err.message) || String(err),
        });
    }
});

async function runCheck(fullPath) {
    let ts;
    try {
        ts = await import('typescript');
    } catch {
        return { ok: false, error: '未安装 TypeScript 运行时解析器，无法完成 TS/JS 语法门禁。' };
    }

    const dir = path.dirname(fullPath);
    const tsconfigPath = ts.findConfigFile(dir, ts.sys.fileExists);

    if (!tsconfigPath) {
        return { ok: true, hasTsconfig: false };
    }

    const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, dir, {}, tsconfigPath);

    // 确保目标文件在编译范围内
    const fileNames = parsedConfig.fileNames.length > 0 ? parsedConfig.fileNames : [fullPath];
    const program = ts.createProgram({
        rootNames: fileNames.includes(fullPath) ? fileNames : [...fileNames, fullPath],
        options: { ...parsedConfig.options, noEmit: true },
        host: ts.createCompilerHost(parsedConfig.options),
    });

    const allDiagnostics = ts.getPreEmitDiagnostics(program).filter((d) => {
        if (!d.file) return false;
        return path.normalize(d.file.fileName) === path.normalize(fullPath);
    });

    const diagnostics = allDiagnostics.slice(0, 30).map((d) => {
        const pos = (d.file && d.file.getLineAndCharacterOfPosition && d.file.getLineAndCharacterOfPosition(d.start || 0))
            || { line: 0, character: 0 };
        const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
        const severity = d.category === 0 ? 'warning' : 'error';
        return {
            line: pos.line + 1,
            column: pos.character + 1,
            message: severity === 'warning' ? `[warning] ${message}` : message,
        };
    });

    const errorCount = allDiagnostics.filter((d) => d.category !== 0).length;
    const warnCount = allDiagnostics.filter((d) => d.category === 0).length;

    return {
        ok: true,
        hasTsconfig: true,
        tsconfigBasename: path.basename(tsconfigPath),
        diagnostics,
        errorCount,
        warnCount,
    };
}
