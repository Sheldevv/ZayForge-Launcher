const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { exec, spawn } = require('child_process');
const os = require('os');

let mainWindow;
let lovePath = null;
let gamePath = null;
let currentRelease = null;

// Disable GPU features to prevent VAAPI errors on Linux
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 960,
        height: 720,
        backgroundColor: '#0a0a12',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: true
        },
        frame: true, // Keep the frame
        title: 'ZayForge Launcher',
        icon: path.join(__dirname, 'assets', 'icon.png'),
        show: false
    });
    
    // Remove the menu bar
    mainWindow.setMenuBarVisibility(false);
    mainWindow.setMenu(null);
    
    mainWindow.loadFile('index.html');
    
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });
}

async function getLatestRelease(includePreReleases = false) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.github.com',
            path: '/repos/Sheldevv/ZayForge/releases',
            method: 'GET',
            headers: {
                'User-Agent': 'ZayForge-Launcher/1.0.0'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const releases = JSON.parse(data);
                    if (!Array.isArray(releases)) {
                        reject(new Error('Failed to fetch releases'));
                        return;
                    }
                    
                    if (releases.length === 0) {
                        reject(new Error('No releases found'));
                        return;
                    }
                    
                    let targetRelease = null;
                    if (includePreReleases) {
                        targetRelease = releases[0];
                    } else {
                        targetRelease = releases.find(r => !r.prerelease);
                        if (!targetRelease && releases.length > 0) {
                            targetRelease = releases[0];
                        }
                    }
                    
                    if (!targetRelease) {
                        reject(new Error('No suitable release found'));
                        return;
                    }
                    
                    const loveAsset = targetRelease.assets.find(a => a.name === 'ZayForge-all.love');
                    if (!loveAsset) {
                        reject(new Error('ZayForge-all.love not found in release'));
                        return;
                    }
                    
                    resolve({
                        version: targetRelease.tag_name,
                        isPreRelease: targetRelease.prerelease,
                        downloadUrl: loveAsset.browser_download_url,
                        releaseDate: targetRelease.published_at,
                        releaseNotes: targetRelease.body,
                        assetSize: loveAsset.size
                    });
                } catch (error) {
                    reject(error);
                }
            });
        });
        
        req.on('error', reject);
        req.end();
    });
}

async function downloadFile(url, destPath, onProgress) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        let receivedBytes = 0;
        
        const followRedirect = (currentUrl) => {
            const request = https.get(currentUrl, {
                headers: {
                    'User-Agent': 'ZayForge-Launcher/1.0.0'
                }
            }, (response) => {
                // Handle redirects (301, 302, 303, 307, 308)
                if (response.statusCode === 301 || response.statusCode === 302 || 
                    response.statusCode === 303 || response.statusCode === 307 || 
                    response.statusCode === 308) {
                    const redirectUrl = response.headers.location;
                    if (redirectUrl) {
                        console.log(`Following redirect to: ${redirectUrl}`);
                        followRedirect(redirectUrl);
                        return;
                    }
                }
                
                if (response.statusCode !== 200) {
                    reject(new Error(`HTTP ${response.statusCode}`));
                    return;
                }
                
                const totalBytes = parseInt(response.headers['content-length'], 10);
                
                response.on('data', (chunk) => {
                    receivedBytes += chunk.length;
                    if (onProgress && totalBytes) {
                        onProgress((receivedBytes / totalBytes) * 100);
                    }
                });
                
                response.pipe(file);
                
                file.on('finish', () => {
                    file.close();
                    resolve();
                });
                
                file.on('error', reject);
            });
            
            request.on('error', reject);
            request.setTimeout(30000, () => {
                request.destroy();
                reject(new Error('Download timeout'));
            });
        };
        
        followRedirect(url);
    });
}

function getLove2DRuntime() {
    const platform = os.platform();
    const userData = app.getPath('userData');
    const portablePath = path.join(userData, 'love');
    
    switch(platform) {
        case 'linux':
            const linuxPaths = [
                '/usr/bin/love',
                '/usr/local/bin/love',
                path.join(portablePath, 'love.AppImage')
            ];
            for (const p of linuxPaths) {
                if (fs.existsSync(p)) {
                    return p;
                }
            }
            break;
            
        case 'win32':
            const windowsPaths = [
                'C:\\Program Files\\LOVE\\love.exe',
                'C:\\Program Files (x86)\\LOVE\\love.exe',
                path.join(portablePath, 'love.exe')
            ];
            for (const p of windowsPaths) {
                if (fs.existsSync(p)) {
                    return p;
                }
            }
            break;
            
        case 'darwin':
            const macPath = '/Applications/love.app/Contents/MacOS/love';
            if (fs.existsSync(macPath)) {
                return macPath;
            }
            break;
    }
    
    return null;
}

async function downloadLove2D(onProgress) {
    const platform = os.platform();
    const loveDir = path.join(app.getPath('userData'), 'love');
    
    if (!fs.existsSync(loveDir)) {
        fs.mkdirSync(loveDir, { recursive: true });
    }
    
    let loveUrl, lovePath;
    
    switch(platform) {
        case 'linux':
            loveUrl = 'https://github.com/love2d/love/releases/download/11.5/love-11.5-x86_64.AppImage';
            lovePath = path.join(loveDir, 'love.AppImage');
            await downloadFile(loveUrl, lovePath, onProgress);
            fs.chmodSync(lovePath, '755');
            break;
            
        case 'win32':
            loveUrl = 'https://github.com/love2d/love/releases/download/11.5/love-11.5-win64.zip';
            lovePath = path.join(loveDir, 'love.zip');
            await downloadFile(loveUrl, lovePath, onProgress);
            
            // Extract zip
            const AdmZip = require('adm-zip');
            const zip = new AdmZip(lovePath);
            zip.extractAllTo(loveDir, true);
            
            // Find love.exe in extracted folder
            const extractedLove = path.join(loveDir, 'love-11.5-win64', 'love.exe');
            if (fs.existsSync(extractedLove)) {
                lovePath = extractedLove;
            } else {
                throw new Error('Failed to extract Love2D');
            }
            break;
            
        case 'darwin':
            loveUrl = 'https://github.com/love2d/love/releases/download/11.5/love-11.5-macos.zip';
            lovePath = path.join(loveDir, 'love.zip');
            await downloadFile(loveUrl, lovePath, onProgress);
            
            const AdmZipMac = require('adm-zip');
            const zipMac = new AdmZipMac(lovePath);
            zipMac.extractAllTo(loveDir, true);
            
            const extractedMac = path.join(loveDir, 'love.app');
            if (fs.existsSync(extractedMac)) {
                lovePath = extractedMac;
            } else {
                throw new Error('Failed to extract Love2D');
            }
            break;
    }
    
    return lovePath;
}

async function runGame(loveRuntime, gameFile) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(loveRuntime)) {
            reject(new Error('Love2D runtime not found'));
            return;
        }
        
        if (!fs.existsSync(gameFile)) {
            reject(new Error('Game file not found'));
            return;
        }
        
        const platform = os.platform();
        let command, args;
        
        if (platform === 'win32') {
            command = loveRuntime;
            args = [gameFile];
        } else if (platform === 'darwin' && loveRuntime.endsWith('.app')) {
            command = 'open';
            args = ['-a', loveRuntime, '--args', gameFile];
        } else {
            command = loveRuntime;
            args = [gameFile];
        }
        
        const gameProcess = spawn(command, args, {
            detached: true,
            stdio: 'ignore'
        });
        
        gameProcess.unref();
        
        gameProcess.on('error', (error) => {
            reject(error);
        });
        
        resolve(gameProcess);
    });
}

function getSavedGamePath(version) {
    const gameDir = path.join(app.getPath('userData'), 'games');
    return path.join(gameDir, `${version}.love`);
}

function isGameInstalled(version) {
    const gamePath = getSavedGamePath(version);
    return fs.existsSync(gamePath);
}

// IPC Handlers
ipcMain.handle('get-releases', async (event, includePreReleases) => {
    try {
        const release = await getLatestRelease(includePreReleases);
        const isInstalled = isGameInstalled(release.version);
        return { 
            success: true, 
            release,
            isInstalled
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('download-game', async (event, downloadUrl, version) => {
    const gameDir = path.join(app.getPath('userData'), 'games');
    const gameFilePath = path.join(gameDir, `${version}.love`);
    
    if (!fs.existsSync(gameDir)) {
        fs.mkdirSync(gameDir, { recursive: true });
    }
    
    try {
        await downloadFile(downloadUrl, gameFilePath, (progress) => {
            event.sender.send('download-progress', { type: 'game', progress });
        });
        return { success: true, path: gameFilePath };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('check-love2d', async () => {
    const loveRuntime = getLove2DRuntime();
    if (loveRuntime) {
        return { success: true, path: loveRuntime };
    }
    return { success: false };
});

ipcMain.handle('download-love2d', async (event) => {
    try {
        const loveRuntime = await downloadLove2D((progress) => {
            event.sender.send('download-progress', { type: 'love2d', progress });
        });
        return { success: true, path: loveRuntime };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('run-game', async (event, loveRuntime, gameFile) => {
    try {
        await runGame(loveRuntime, gameFile);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('get-installed-version', async () => {
    const gameDir = path.join(app.getPath('userData'), 'games');
    if (!fs.existsSync(gameDir)) return null;
    
    const files = fs.readdirSync(gameDir);
    const loveFiles = files.filter(f => f.endsWith('.love'));
    if (loveFiles.length === 0) return null;
    
    // Get the most recently modified
    let latestFile = null;
    let latestTime = 0;
    for (const file of loveFiles) {
        const filePath = path.join(gameDir, file);
        const stats = fs.statSync(filePath);
        if (stats.mtimeMs > latestTime) {
            latestTime = stats.mtimeMs;
            latestFile = file;
        }
    }
    
    if (latestFile) {
        const version = latestFile.replace('.love', '');
        return { version, path: path.join(gameDir, latestFile) };
    }
    return null;
});

app.whenReady().then(() => {
    createWindow();
    
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});