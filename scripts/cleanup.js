/**
 * cleanup.js - 프로그램 제거 시 실행되는 정리 스크립트
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

try {
  // 앱 데이터 디렉토리 찾기
  const appDataPath = process.env.APPDATA || 
    (process.platform === 'darwin' ? 
      path.join(process.env.HOME, 'Library/Application Support') : 
      path.join(process.env.HOME, '.config'));
  
  // 앱 데이터 폴더 삭제
  const appFolder = path.join(appDataPath, 'PandoPGC');
  if (fs.existsSync(appFolder)) {
    console.log(`Removing app data folder: ${appFolder}`);
    fs.rmSync(appFolder, { recursive: true, force: true });
  }
  
  // 레지스트리 항목 정리 (Windows만)
  if (process.platform === 'win32') {
    try {
      // 레지스트리에서 언인스톨러 정보 제거
      console.log('Cleaning registry entries...');
      execSync(`reg delete "HKEY_CURRENT_USER\\Software\\PandoPGC" /f`, { stdio: 'ignore' });
      execSync(`reg delete "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{6AC38689-2D6A-4FDD-A2AB-F96284A234D0}_is1" /f`, { stdio: 'ignore' });
    } catch (regErr) {
      // 레지스트리 항목이 없을 수 있으므로 오류 무시
      console.log('Registry entries might not exist or already removed.');
    }
  }
  
  console.log('Cleanup completed successfully.');
} catch (error) {
  console.error('Error during cleanup:', error);
}