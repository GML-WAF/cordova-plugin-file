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

// Forwards the File actions to the main process handler (src/electron) and converts its errors to FileError codes.

const SERVICE = 'FileElectron';
const UNKNOWN_ERR = 1000;

const ACTIONS = [
    'requestFileSystem', 'requestAllFileSystems', 'requestAllPaths', 'resolveLocalFileSystemURI',
    'getFileMetadata', 'getParent', 'getDirectory', 'getFile', 'remove', 'removeRecursively',
    'moveTo', 'copyTo', 'readEntries', 'readAsText', 'readAsDataURL', 'readAsBinaryString',
    'readAsArrayBuffer', 'write', 'truncate', 'testSaveLocationExists', 'testFileExists',
    'testDirectoryExists', 'getFreeDiskSpace', '_getLocalFilesystemPath'
];

function toErrorCode (err) {
    const match = /FILE_ERR:(\d+)/.exec((err && err.message) || String(err));
    return match ? parseInt(match[1], 10) : UNKNOWN_ERR;
}

function toArrayBuffer (result) {
    if (ArrayBuffer.isView(result)) {
        return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength);
    }
    return result;
}

const proxy = {};

ACTIONS.forEach(function (action) {
    proxy[action] = function (success, fail, args) {
        if (!window._cdvElectronIpc || !window._cdvElectronIpc.hasService(SERVICE)) {
            fail(UNKNOWN_ERR);
            return;
        }

        window._cdvElectronIpc.exec(
            function (result) {
                // The main process reports FileErrors as { __cdvFileError: code } (see src/electron/index.js).
                if (result && typeof result === 'object' && typeof result.__cdvFileError === 'number') {
                    fail(result.__cdvFileError);
                    return;
                }
                success(action === 'readAsArrayBuffer' ? toArrayBuffer(result) : result);
            },
            function (err) {
                fail(toErrorCode(err));
            },
            SERVICE,
            action,
            args || []
        );
    };
});

require('cordova/exec/proxy').add('File', proxy);
