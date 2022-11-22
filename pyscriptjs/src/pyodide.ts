import { Runtime } from './runtime';
import { getLogger } from './logger';
import { FetchError } from './exceptions'
import type { loadPyodide as loadPyodideDeclaration, PyodideInterface, PyProxy } from 'pyodide';
// eslint-disable-next-line
// @ts-ignore
import pyscript from './python/pyscript.py';
import type { AppConfig } from './pyconfig';
import type { Stdio } from './stdio';
import { shouldSelectPythonPath, getRawFileName } from './utils';
declare const loadPyodide: typeof loadPyodideDeclaration;

const logger = getLogger('pyscript/pyodide');

interface Micropip {
    install: (packageName: string | string[]) => Promise<void>;
    destroy: () => void;
}

interface SafeFetchResult {
    status: number;
    statusText: string;
    arrayBuffer(): Promise<ArrayBuffer>;
    text(): Promise<string>;
}

class LocalFileResult {
    localFile: File;
    status: number = 200;
    statusText: string = "OK";

    constructor(localFile: File) {
        this.localFile = localFile;
    }

    arrayBuffer(): Promise<ArrayBuffer> {
        return new Promise(async (resolve) => {
            let ab = await this.localFile.arrayBuffer();
            let dec = new TextDecoder();
            localStorage.setItem(this.name, dec.decode(ab));
            resolve(ab)
        });
    }

    text(): Promise<string> {
        return new Promise(async (resolve) => {
            let ab = await this.localFile.arrayBuffer();
            let dec = new TextDecoder();
            let content = dec.decode(ab);
            localStorage.setItem(this.name, content);
            resolve(content)
        });
    }

    get name(): string {
        return getRawFileName(this.localFile.name);
    }
}

export class PyodideRuntime extends Runtime {
    src: string;
    stdio: Stdio;
    name?: string;
    lang?: string;
    interpreter: PyodideInterface;
    globals: PyProxy;
    pythonPath: FileSystemDirectoryHandle;

    constructor(
        config: AppConfig,
        stdio: Stdio,
        src = 'https://cdn.jsdelivr.net/pyodide/v0.21.3/full/pyodide.js',
        name = 'pyodide-default',
        lang = 'python',
    ) {
        logger.info('Runtime config:', { name, lang, src });
        super(config);
        this.stdio = stdio;
        this.src = src;
        this.name = name;
        this.lang = lang;
    }

    /**
     * Although `loadPyodide` is used below,
     * notice that it is not imported i.e.
     * import { loadPyodide } from 'pyodide';
     * is not used at the top of this file.
     *
     * This is because, if it's used, loadPyodide
     * behaves mischievously i.e. it tries to load
     * `pyodide.asm.js` and `pyodide_py.tar` but
     * with paths that are wrong such as:
     *
     * http://127.0.0.1:8080/build/pyodide_py.tar
     * which results in a 404 since `build` doesn't
     * contain these files and is clearly the wrong
     * path.
     */
    async loadInterpreter(): Promise<void> {
        logger.info('Loading pyodide');
        this.interpreter = await loadPyodide({
            stdout: (msg: string) => { this.stdio.stdout_writeline(msg); },
            stderr: (msg: string) => { this.stdio.stderr_writeline(msg); },
            fullStdLib: false,
        });

        this.globals = this.interpreter.globals;

        // XXX: ideally, we should load micropip only if we actually need it
        await this.loadPackage('micropip');

        logger.info('importing pyscript.py');
        this.run(pyscript as string);

        logger.info('pyodide loaded and initialized');
    }

    run(code: string) {
        return this.interpreter.runPython(code);
    }

    registerJsModule(name: string, module: object): void {
        this.interpreter.registerJsModule(name, module);
    }

    async loadPackage(names: string | string[]): Promise<void> {
        logger.info(`pyodide.loadPackage: ${names.toString()}`);
        await this.interpreter.loadPackage(names, logger.info.bind(logger), logger.info.bind(logger));
    }

    async installPackage(package_name: string | string[]): Promise<void> {
        if (package_name.length > 0) {
            logger.info(`micropip install ${package_name.toString()}`);
            const micropip = this.globals.get('micropip') as Micropip;
            await micropip.install(package_name);
            micropip.destroy();
        }
    }

    async loadFromFile(path: string, fetch_path: string): Promise<void> {
        const pathArr = path.split('/');
        const filename = pathArr.pop();
        for (let i = 0; i < pathArr.length; i++) {
            const eachPath = pathArr.slice(0, i + 1).join('/');
            const { exists, parentExists } = this.interpreter.FS.analyzePath(eachPath);
            if (!parentExists) {
                throw new Error(`'INTERNAL ERROR! cannot create ${path}, this should never happen'`);
            }
            if (!exists) {
                this.interpreter.FS.mkdir(eachPath);
            }
        }
        const response = await this.safeFetch(fetch_path);
        if (response.status !== 200) {
            throw new FetchError(`Unable to fetch  ${fetch_path}, reason: ${response.status} - ${response.statusText}`);
        }
        const buffer = await response.arrayBuffer();
        const data = new Uint8Array(buffer);
        pathArr.push(filename);
        const stream = this.interpreter.FS.open(pathArr.join('/'), 'w');
        this.interpreter.FS.write(stream, data, 0, data.length, 0);
        this.interpreter.FS.close(stream);
    }

    async safeFetch(s: string): Promise<SafeFetchResult> {
        let response: SafeFetchResult; 

        if (shouldSelectPythonPath()) {
            if (this.hasCachedLocalFile(s)) {
                response= this.getCachedLocalFile(s);
            } else {
                response = new LocalFileResult(await this.getSourceFromLocalFile(s));
            }
        } else {
            response = await fetch(s);
        }
        return response;
    }

    async getSourceFromLocalFile(s: string): Promise<File> {
        let response: File;
        if (this.pythonPath === undefined) {
            this.pythonPath = await this.showSelectPythonPath();
        }

        const parts: string[] = s.split('/').filter((i) => i !== '.' && i !== '..').reverse();
        let startingDir: FileSystemDirectoryHandle = this.pythonPath;
        let segment: string = parts.pop();

        // Drill into the hierarchy
        // TODO: The next two sections need TLC; could be DRYer.
        while(!segment.endsWith(".py")) {
            // @ts-ignore
            const entries: Iterator<FileSystemDirectoryEntry> = await startingDir.entries();
            // @ts-ignore
            let entry: FileSystemDirectoryEntry = await entries.next();
            // @ts-ignore
            while(!entry.done) {
                // @ts-ignore
                if (entry.value[0] === segment) {
                    // @ts-ignore
                    startingDir = entry.value[1];
                    break;
                }
                // @ts-ignore
                entry = await entries.next();
            }
            segment = parts.pop();
        }

        // @ts-ignore
        const entries: Iterator<FileSystemDirectoryEntry> = await startingDir.entries();
        // @ts-ignore
        let entry: FileSystemDirectoryEntry = await entries.next();
        // @ts-ignore
        while(!entry.done) {
            // @ts-ignore
            if (entry.value && entry.value[0] === segment) {
                // @ts-ignore
                response = await entry.value[1].getFile();
                break;
            }
            // @ts-ignore
            entry = await entries.next();
        }

        return response;
    }

    showSelectPythonPath(): Promise<FileSystemDirectoryHandle> {
        return new Promise((resolve) => {
            let localModal = document.createElement('div');
            localModal.className = 'local-modal';

            let modalContent = document.createElement('div');
            modalContent.className = 'modal-content';

            let message = document.createElement('p');
            message.innerHTML = "When running locally, it is necessary for the user to select the directory "+
                "(PYTHONPATH) from which to load additional modules/scripts. To select the directory, click the "+
                "button below.";

            let button = document.createElement('button')
            let setPythonPathCB = (handle: FileSystemDirectoryHandle) => resolve(handle);
            button.onclick = async function() {
                // @ts-ignore
                let _dir = await window.showDirectoryPicker();
                // @ts-ignore
                setTimeout(() => {
                    setPythonPathCB(_dir);
                    document.body.removeChild(localModal);
                }, 100);
            }
            button.innerHTML = "Set Python Path";

            modalContent.appendChild(message);
            modalContent.appendChild(button);
            localModal.appendChild(modalContent);
            document.body.insertBefore(localModal, document.body.childNodes[0]);
        });
    }

    hasCachedLocalFile(filename: string): boolean {
        return localStorage.getItem(getRawFileName(filename)) !== null;
    }

    getCachedLocalFile(filename: string): LocalFileResult {
        let raw: string = getRawFileName(filename);
        return new LocalFileResult(
            new File([localStorage.getItem(raw)], raw, {type: "text/plain"})
        );
    }
}
