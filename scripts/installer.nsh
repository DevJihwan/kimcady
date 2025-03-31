; Custom NSIS script for PandoPGC

; 추가 백업 언인스톨러 설정
!macro customUnInstall
  ; 백업 언인스톨러 파일 복사 
  CreateDirectory "$APPDATA\PandoPGC"
  CopyFiles "$INSTDIR\resources\uninstaller.js" "$APPDATA\PandoPGC\uninstaller.js"
  
  ; 언인스톨러 레지스트리 백업 키 생성
  WriteRegStr HKCU "Software\PandoPGC" "UninstallString" "$INSTDIR\Uninstall PandoPGC.exe"
  WriteRegStr HKCU "Software\PandoPGC" "InstallLocation" "$INSTDIR"
!macroend

; 설치 전 이전 설치 정리
!macro preInit
  ; 이전 설치 잔여물 확인 및 정리
  ReadRegStr $0 HKCU "Software\PandoPGC" "InstallLocation"
  ${If} $0 != ""
    RMDir /r "$0"
  ${EndIf}
  
  ; 이전 앱 데이터 정리
  RMDir /r "$APPDATA\PandoPGC"
!macroend