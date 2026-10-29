/**
 * node-runtime.ts
 *
 * Self-contained Node.js runtime installer for the pet:
 *  - downloads the official nodejs.org Windows zip (latest LTS, exact arch)
 *  - extracts it into userData/runtime/node (no admin rights touched)
 *  - npm ships inside that zip, so after this `npm --version` works via PATH
 *
 * Never touches an existing system Node installation. The pet prepends the
 * runtime dir to its own PATH only, so OpenCode installs there too.
 */
export interface NodeRuntimeResult {
    readonly ok: boolean;
    /** Directory containing node.exe / npm.cmd; caller prepends it to PATH. */
    readonly nodeDir?: string;
    readonly error?: string;
}
export type Progress = (message: string) => void;
/**
 * Download the latest LTS Node Windows zip for this machine's arch, extract it
 * under userData/runtime/node, and return that directory.
 */
export declare function installNodeRuntime(userDataPath: string, onProgress?: Progress): Promise<NodeRuntimeResult>;
