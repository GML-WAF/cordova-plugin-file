/*
 *
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 *
 */

// Main process implementation of the File plugin actions. Mirrors the behaviour of the Android implementation.

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { app } = require('electron');

const IS_WIN = process.platform === 'win32';

const ERR = {
    NOT_FOUND: 1,
    NOT_READABLE: 4,
    ENCODING: 5,
    NO_MODIFICATION_ALLOWED: 6,
    INVALID_MODIFICATION: 9,
    QUOTA_EXCEEDED: 10,
    TYPE_MISMATCH: 11,
    PATH_EXISTS: 12,
    UNKNOWN: 1000
};

class FileError extends Error {
    constructor (code) {
        super('FILE_ERR:' + code);
        this.code = code;
    }
}

const NODE_ERR_CODES = {
    ENOENT: ERR.NOT_FOUND,
    ENOTDIR: ERR.NOT_FOUND,
    EACCES: ERR.NO_MODIFICATION_ALLOWED,
    EPERM: ERR.NO_MODIFICATION_ALLOWED,
    EROFS: ERR.NO_MODIFICATION_ALLOWED,
    EEXIST: ERR.PATH_EXISTS,
    ENOTEMPTY: ERR.INVALID_MODIFICATION,
    EISDIR: ERR.NOT_READABLE,
    ENOSPC: ERR.QUOTA_EXCEEDED
};

function codeFor (e) {
    if (e instanceof FileError) return e.code;
    return NODE_ERR_CODES[e && e.code] || ERR.UNKNOWN;
}

// Errors are returned as { __cdvFileError: code } instead of being thrown: Electron logs every
// exception thrown by an ipcMain.handle() handler to the console, although failures like
// NOT_FOUND are expected results. The renderer proxy unwraps the envelope and calls the error callback.
const ERROR_KEY = '__cdvFileError';

function define (fn) {
    return async function (args) {
        // Some cordova-electron versions box the arguments in an additional array.
        const unboxed = Array.isArray(args) && args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
        try {
            return await fn(unboxed || []);
        } catch (e) {
            const code = codeFor(e);
            if (code === ERR.UNKNOWN) console.error('cordova-plugin-file:', e);
            return { [ERROR_KEY]: code };
        }
    };
}

// ---------------------------------------------------------------------------
// Filesystems
// ---------------------------------------------------------------------------

let filesystems = null;

function getFilesystems () {
    if (!filesystems) {
        const userData = app.getPath('userData');
        const persistent = path.join(userData, 'data');
        const temporary = path.join(userData, 'cordova-cache');
        fs.mkdirSync(persistent, { recursive: true });
        fs.mkdirSync(temporary, { recursive: true });

        filesystems = [
            { name: 'persistent', root: persistent },
            { name: 'temporary', root: temporary },
            { name: 'documents', root: app.getPath('documents') },
            { name: 'application', root: app.getAppPath(), readOnly: true },
            // On Windows the root filesystem spans all drives: fullPath is "/C:/dir/file".
            { name: 'root', root: IS_WIN ? null : path.parse(persistent).root }
        ];
    }
    return filesystems;
}

function getFilesystem (name) {
    return getFilesystems().find(f => f.name === name) || null;
}

function normalizeCase (p) {
    return IS_WIN ? p.toLowerCase() : p;
}

function isInside (child, parent) {
    const c = normalizeCase(child);
    const p = normalizeCase(parent);
    if (c === p) return true;
    return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

function cleanFullPath (p) {
    const n = path.posix.normalize('/' + p);
    return n.length > 1 && n.endsWith('/') ? n.slice(0, -1) : n;
}

function realForFullPath (fsObj, fullPath) {
    if (fsObj.root === null) {
        const sysDrive = (process.env.SystemDrive || 'C:') + '\\';
        let p = fullPath.slice(1);
        if (!p) return sysDrive;
        if (/^[A-Za-z]:$/.test(p)) p += '\\';
        return path.win32.normalize(/^[A-Za-z]:/.test(p) ? p : path.win32.join(sysDrive, p));
    }
    // No path.join(root, '/') for the root itself: the trailing separator ("...\app.asar\")
    // cannot be resolved by Electron's asar support, so the "application" filesystem would be missing.
    return fullPath === '/' ? fsObj.root : path.join(fsObj.root, fullPath);
}

function location (fsObj, fullPath) {
    const clean = cleanFullPath(fullPath);
    return { fs: fsObj, fullPath: clean, real: realForFullPath(fsObj, clean) };
}

function locationForReal (realPath) {
    const real = path.resolve(realPath);
    let best = null;
    for (const f of getFilesystems()) {
        if (f.name !== 'root' && isInside(real, f.root) && (!best || f.root.length > best.root.length)) {
            best = f;
        }
    }
    if (best) {
        const rel = path.relative(best.root, real);
        return { fs: best, fullPath: cleanFullPath(rel.split(path.sep).join('/')), real };
    }
    const rootFs = getFilesystem('root');
    const full = rootFs.root === null
        ? '/' + real.split(path.sep).join('/')
        : path.relative(rootFs.root, real).split(path.sep).join('/');
    return { fs: rootFs, fullPath: cleanFullPath(full), real };
}

// Resolves cdvfile://, file:// URLs and native paths.
function parseURL (str) {
    if (typeof str !== 'string' || !str) throw new FileError(ERR.ENCODING);

    try {
        const cdv = /^cdvfile:\/\/localhost\/([^/]+)(\/.*)?$/.exec(str);
        if (cdv) {
            const fsObj = getFilesystem(decodeURIComponent(cdv[1]));
            if (!fsObj) throw new FileError(ERR.ENCODING);
            return location(fsObj, decodeURIComponent(cdv[2] || '/'));
        }
        if (/^file:/i.test(str)) {
            return locationForReal(fileURLToPath(str));
        }
    } catch (e) {
        if (e instanceof FileError) throw e;
        throw new FileError(ERR.ENCODING);
    }

    if (/^(\/|[A-Za-z]:[\\/])/.test(str)) {
        return locationForReal(str);
    }
    throw new FileError(ERR.ENCODING);
}

function assertWritable (loc) {
    if (loc.fs.readOnly) throw new FileError(ERR.NO_MODIFICATION_ALLOWED);
}

function validateName (name) {
    if (typeof name !== 'string' || name.includes(':') || /[\\/]/.test(name)) {
        throw new FileError(ERR.ENCODING);
    }
}

async function statOrNull (p) {
    try {
        return await fsp.stat(p);
    } catch (e) {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

function makeEntry (loc, stat) {
    const isDir = stat.isDirectory();
    const slash = isDir && loc.fullPath !== '/' ? '/' : '';
    let nativeURL = pathToFileURL(loc.real).href;
    if (isDir && !nativeURL.endsWith('/')) nativeURL += '/';
    return {
        isFile: !isDir,
        isDirectory: isDir,
        name: loc.fullPath === '/' ? '' : path.posix.basename(loc.fullPath),
        fullPath: loc.fullPath + slash,
        filesystem: loc.fs.name === 'temporary' ? 0 : 1,
        filesystemName: loc.fs.name,
        nativeURL
    };
}

async function entryFor (loc) {
    const stat = await fsp.stat(loc.real);
    return makeEntry(loc, stat);
}

async function rootEntry (fsObj) {
    return entryFor(location(fsObj, '/'));
}

function childLocation (loc, name) {
    return { fs: loc.fs, fullPath: cleanFullPath(loc.fullPath + '/' + name), real: path.join(loc.real, name) };
}

// ---------------------------------------------------------------------------
// Helpers for reading and writing
// ---------------------------------------------------------------------------

const MIME_TYPES = {
    '.txt': 'text/plain',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.csv': 'text/csv',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip'
};

function mimeFor (p) {
    return MIME_TYPES[path.extname(p).toLowerCase()] || null;
}

async function readRange (url, start, end) {
    const loc = parseURL(url);
    const stat = await fsp.stat(loc.real);
    if (stat.isDirectory()) throw new FileError(ERR.NOT_READABLE);

    const from = Math.max(0, Number(start) || 0);
    const to = Math.min(stat.size, end === undefined || end === null ? stat.size : Number(end));
    const length = to - from;
    if (length <= 0) return { loc, buffer: Buffer.alloc(0) };

    const fh = await fsp.open(loc.real, 'r');
    try {
        const buffer = Buffer.alloc(length);
        let read = 0;
        while (read < length) {
            const { bytesRead } = await fh.read(buffer, read, length - read, from + read);
            if (bytesRead === 0) break;
            read += bytesRead;
        }
        return { loc, buffer: read < length ? buffer.subarray(0, read) : buffer };
    } finally {
        await fh.close();
    }
}

function toBuffer (data) {
    if (typeof data === 'string') return Buffer.from(data, 'utf8');
    if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (data instanceof ArrayBuffer || Object.prototype.toString.call(data) === '[object ArrayBuffer]') return Buffer.from(data);
    throw new FileError(ERR.ENCODING);
}

function decodeText (buffer, encoding) {
    try {
        return new TextDecoder(encoding || 'utf-8', { ignoreBOM: true }).decode(buffer);
    } catch (e) {
        throw new FileError(ERR.ENCODING);
    }
}

// ---------------------------------------------------------------------------
// Copy / move
// ---------------------------------------------------------------------------

async function transferTo (args, move) {
    const [srcUrl, parentUrl, newName] = args;
    const src = parseURL(srcUrl);
    const parent = parseURL(parentUrl);

    const srcStat = await fsp.stat(src.real);
    const parentStat = await statOrNull(parent.real);
    if (!parentStat || !parentStat.isDirectory()) throw new FileError(ERR.NOT_FOUND);

    const name = newName || path.posix.basename(src.fullPath);
    validateName(name);
    const dest = childLocation(parent, name);

    assertWritable(dest);
    if (move) assertWritable(src);

    if (normalizeCase(dest.real) === normalizeCase(src.real)) throw new FileError(ERR.INVALID_MODIFICATION);

    const destStat = await statOrNull(dest.real);
    if (destStat) {
        if (!srcStat.isDirectory() && destStat.isDirectory()) throw new FileError(ERR.INVALID_MODIFICATION);
        if (srcStat.isDirectory() && !destStat.isDirectory()) throw new FileError(ERR.INVALID_MODIFICATION);
    }

    if (srcStat.isDirectory()) {
        if (isInside(dest.real, src.real)) throw new FileError(ERR.INVALID_MODIFICATION);
        if (destStat && (await fsp.readdir(dest.real)).length > 0) throw new FileError(ERR.INVALID_MODIFICATION);
    }

    if (move) {
        if (destStat && srcStat.isDirectory()) await fsp.rmdir(dest.real);
        try {
            await fsp.rename(src.real, dest.real);
        } catch (e) {
            if (e.code !== 'EXDEV') throw e;
            await fsp.cp(src.real, dest.real, { recursive: true });
            await fsp.rm(src.real, { recursive: true });
        }
    } else if (srcStat.isDirectory()) {
        await fsp.cp(src.real, dest.real, { recursive: true });
    } else {
        await fsp.copyFile(src.real, dest.real);
    }

    return entryFor(dest);
}

// ---------------------------------------------------------------------------
// getFile / getDirectory
// ---------------------------------------------------------------------------

async function getFileImpl (args, directory) {
    const [dirUrl, requested, options] = args;
    const dir = parseURL(dirUrl);
    const create = !!(options && options.create);
    const exclusive = create && !!options.exclusive;

    if (typeof requested !== 'string' || requested.includes(':')) throw new FileError(ERR.ENCODING);

    const loc = location(dir.fs, requested.startsWith('/') ? requested : dir.fullPath + '/' + requested);
    const stat = await statOrNull(loc.real);

    if (stat) {
        if (exclusive) throw new FileError(ERR.PATH_EXISTS);
        if (directory !== stat.isDirectory()) throw new FileError(ERR.TYPE_MISMATCH);
        return makeEntry(loc, stat);
    }

    if (!create) throw new FileError(ERR.NOT_FOUND);

    assertWritable(loc);
    // The parent has to exist, as on the other platforms.
    if (directory) {
        await fsp.mkdir(loc.real);
    } else {
        await (await fsp.open(loc.real, 'wx')).close();
    }
    return entryFor(loc);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const actions = {
    requestFileSystem: async ([type]) => {
        const fsObj = getFilesystem(type === 0 ? 'temporary' : type === 1 ? 'persistent' : '');
        if (!fsObj) throw new FileError(ERR.NOT_FOUND);
        return { name: fsObj.name, root: await rootEntry(fsObj) };
    },

    requestAllFileSystems: async () => {
        const result = [];
        for (const fsObj of getFilesystems()) {
            try {
                result.push(await rootEntry(fsObj));
            } catch (e) {
                // e.g. directory not available on this system
            }
        }
        return result;
    },

    requestAllPaths: async () => {
        const dirUrl = p => {
            const href = pathToFileURL(p).href;
            return href.endsWith('/') ? href : href + '/';
        };
        const fsList = getFilesystems();
        const userData = app.getPath('userData');
        return {
            applicationDirectory: dirUrl(app.getAppPath()),
            applicationStorageDirectory: dirUrl(userData),
            dataDirectory: dirUrl(fsList.find(f => f.name === 'persistent').root),
            cacheDirectory: dirUrl(fsList.find(f => f.name === 'temporary').root),
            tempDirectory: dirUrl(app.getPath('temp')),
            documentsDirectory: dirUrl(app.getPath('documents'))
        };
    },

    resolveLocalFileSystemURI: async ([url]) => entryFor(parseURL(url)),

    getFileMetadata: async ([url]) => {
        const loc = parseURL(url);
        const stat = await fsp.stat(loc.real);
        return {
            size: stat.isDirectory() ? 0 : stat.size,
            type: stat.isDirectory() ? null : mimeFor(loc.real),
            name: loc.fullPath === '/' ? '' : path.posix.basename(loc.fullPath),
            fullPath: loc.fullPath,
            lastModifiedDate: Math.floor(stat.mtimeMs)
        };
    },

    getParent: async ([url]) => {
        const loc = parseURL(url);
        await fsp.stat(loc.real);
        if (loc.fullPath === '/') return entryFor(loc);
        return entryFor(location(loc.fs, path.posix.dirname(loc.fullPath)));
    },

    getDirectory: args => getFileImpl(args, true),

    getFile: args => getFileImpl(args, false),

    remove: async ([url]) => {
        const loc = parseURL(url);
        if (loc.fullPath === '/') throw new FileError(ERR.NO_MODIFICATION_ALLOWED);
        assertWritable(loc);
        const stat = await fsp.lstat(loc.real);
        if (stat.isDirectory()) {
            await fsp.rmdir(loc.real);
        } else {
            await fsp.unlink(loc.real);
        }
    },

    removeRecursively: async ([url]) => {
        const loc = parseURL(url);
        if (loc.fullPath === '/') throw new FileError(ERR.NO_MODIFICATION_ALLOWED);
        assertWritable(loc);
        await fsp.lstat(loc.real);
        await fsp.rm(loc.real, { recursive: true });
    },

    moveTo: args => transferTo(args, true),

    copyTo: args => transferTo(args, false),

    readEntries: async ([url]) => {
        const loc = parseURL(url);
        const names = await fsp.readdir(loc.real);
        const entries = await Promise.all(names.map(async name => {
            const child = childLocation(loc, name);
            const stat = await statOrNull(child.real);
            return stat ? makeEntry(child, stat) : null;
        }));
        return entries.filter(Boolean);
    },

    readAsText: async ([url, encoding, start, end]) => {
        const { buffer } = await readRange(url, start, end);
        return decodeText(buffer, encoding);
    },

    readAsDataURL: async ([url, start, end]) => {
        const { loc, buffer } = await readRange(url, start, end);
        return 'data:' + (mimeFor(loc.real) || 'application/octet-stream') + ';base64,' + buffer.toString('base64');
    },

    readAsBinaryString: async ([url, start, end]) => {
        const { buffer } = await readRange(url, start, end);
        return buffer.toString('latin1');
    },

    readAsArrayBuffer: async ([url, start, end]) => {
        const { buffer } = await readRange(url, start, end);
        // A dedicated copy, so that no pooled memory is serialized.
        return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },

    // Like on Android: the file is cut at `position` and the data is written there.
    write: async ([url, data, position]) => {
        const loc = parseURL(url);
        assertWritable(loc);
        const buffer = toBuffer(data);
        const offset = Math.max(0, Number(position) || 0);

        const fh = await fsp.open(loc.real, offset > 0 ? 'r+' : 'w');
        try {
            const writeAt = offset > 0 ? Math.min(offset, (await fh.stat()).size) : 0;
            if (offset > 0) await fh.truncate(writeAt);
            let written = 0;
            while (written < buffer.length) {
                const { bytesWritten } = await fh.write(buffer, written, buffer.length - written, writeAt + written);
                written += bytesWritten;
            }
            return buffer.length;
        } finally {
            await fh.close();
        }
    },

    truncate: async ([url, size]) => {
        const loc = parseURL(url);
        assertWritable(loc);
        const target = Math.max(0, Number(size) || 0);
        const fh = await fsp.open(loc.real, 'r+');
        try {
            const length = (await fh.stat()).size;
            if (length >= target) {
                await fh.truncate(target);
                return target;
            }
            return length;
        } finally {
            await fh.close();
        }
    },

    testSaveLocationExists: async () => true,

    testFileExists: async ([url]) => !!(await statOrNull(parseURL(url).real)),

    testDirectoryExists: async ([url]) => !!(await statOrNull(parseURL(url).real)),

    getFreeDiskSpace: async () => {
        try {
            const s = await fsp.statfs(app.getPath('userData'));
            return s.bavail * s.bsize;
        } catch (e) {
            return 0;
        }
    },

    // Internal method for testing: on-disk location of a local filesystem url.
    _getLocalFilesystemPath: async ([url]) => parseURL(url).real
};

for (const name of Object.keys(actions)) {
    module.exports[name] = define(actions[name]);
}
