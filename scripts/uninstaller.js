/**
 * uninstaller.js - 백업 언인스톨러 스크립트
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// 프로그램 설치 디렉토리 확인
const programFilesPath = process.env.PROGRAMFILES || 'C:\\Program Files';
const x86Path = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';

const possiblePaths = [
  path.join(programFilesPath, 'PandoPGC'),
  path.join(x86Path, 'PandoPGC')
];

// 앱 데이터 폴더
const appDataPath = process.env.APPDATA || 
  (process.platform === 'darwin' ? 
    path.join(process.env.HOME, 'Library/Application Support') : 
    path.join(process.env.HOME, '.config'));

const appFolder = path.join(appDataPath, 'PandoPGC');

// 수동 제거 함수
function manualUninstall() {
  console.log('Starting manual uninstallation process...');
  
  // 1. 프로그램 폴더 삭제
  possiblePaths.forEach(folderPath => {
    if (fs.existsSync(folderPath)) {
      console.log(`Removing program folder: ${folderPath}`);
      try {
        fs.rmSync(folderPath, { recursive: true, force: true });
      } catch (err) {
        console.error(`Error removing folder ${folderPath}:`, err);
      }
    }
  });
  
  // 2. 앱 데이터 폴더 삭제
  if (fs.existsSync(appFolder)) {
    console.log(`Removing app data folder: ${appFolder}`);
    try {
      fs.rmSync(appFolder, { recursive: true, force: true });
    } catch (err) {
      console.error(`Error removing app data folder:`, err);
    }
  }
  
  // 3. 바탕화면 및 시작 메뉴 바로가기 삭제
  const desktopPath = path.join(process.env.USERPROFILE, 'Desktop', 'PandoPGC.lnk');
  const startMenuPath = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'PandoPGC.lnk');
  
  [desktopPath, startMenuPath].forEach(shortcut => {
    if (fs.existsSync(shortcut)) {
      console.log(`Removing shortcut: ${shortcut}`);
      try {
        fs.unlinkSync(shortcut);
      } catch (err) {
        console.error(`Error removing shortcut ${shortcut}:`, err);
      }
    }
  });
  
  // 4. 레지스트리 항목 삭제 (Windows만)
  if (process.platform === 'win32') {
    console.log('Cleaning registry entries...');
    try {
      exec('reg delete "HKEY_CURRENT_USER\\Software\\PandoPGC" /f');
      exec('reg delete "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{6AC38689-2D6A-4FDD-A2AB-F96284A234D0}_is1" /f');
    } catch (regErr) {
      console.error('Error cleaning registry:', regErr);
    }
  }
  
  console.log('Manual uninstallation completed.');
}

// 실행
manualUninstall();