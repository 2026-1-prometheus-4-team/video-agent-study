# Windows zsh 환경 세팅 가이드

Mac 처럼 화살표 프롬프트 + 자동완성이 되는 터미널을 Windows 에서 쓰기 위한 세팅.
WSL2 (Ubuntu) 위에 zsh + oh-my-zsh + powerlevel10k + 자동완성 플러그인을 올린다.

## 설치 항목

- **zsh** - bash 대신 쓸 셸
- **oh-my-zsh** - zsh 설정 프레임워크
- **powerlevel10k** - 화살표 프롬프트 테마
- **zsh-autosuggestions** - 회색으로 자동완성 미리보기
- **zsh-syntax-highlighting** - 명령어 색칠

## 사전 준비

### 1. WSL2 + Ubuntu 설치

이미 WSL 깔려있으면 건너뛰기.

PowerShell 관리자 권한으로 실행

```powershell
wsl --install
```

설치 후 재부팅. Ubuntu 가 자동으로 뜨면 사용자 계정 만들기.

확인

```powershell
wsl -l -v
```

### 2. 레포 클론

Ubuntu(WSL) 터미널에서

```bash
cd ~
git clone https://github.com/2026-1-prometheus-4-team/video-agent-study.git
cd video-agent-study
```

## 설치 실행

```bash
bash scripts/setup_zsh_windows.sh
```

스크립트가 알아서 다 깔아준다.
끝나면 **터미널을 닫고 다시 열기**.

새 터미널이 뜨면 powerlevel10k 설정 마법사가 자동 실행됨.
화살표 키로 원하는 스타일 골라가면 됨.
나중에 다시 설정하고 싶으면

```bash
p10k configure
```

## 폰트 설치 (필수)

폰트 안 깔면 화살표/아이콘이 네모로 깨져 보인다.

1. <https://github.com/romkatv/powerlevel10k-media> 에서 아래 4개 파일 다운로드
   - `MesloLGS NF Regular.ttf`
   - `MesloLGS NF Bold.ttf`
   - `MesloLGS NF Italic.ttf`
   - `MesloLGS NF Bold Italic.ttf`
2. 다운받은 파일 우클릭 → 설치 (4개 다)
3. Windows Terminal 설정
   - `Ctrl + ,` 로 설정 열기
   - 좌측 프로필 목록에서 **Ubuntu** 선택
   - **모양** 탭 → **글꼴** → `MesloLGS NF` 로 변경
   - 저장

## 확인

새 터미널 열어서 아래처럼 보이면 성공

```
~/Work  main
> _
```

명령어 치다 보면 회색으로 이전에 쳤던 것이 자동완성으로 미리 뜸.
오른쪽 화살표 키로 채택.

## 트러블슈팅

### 화살표/아이콘이 네모로 보임

폰트가 안 깔렸거나 Windows Terminal 글꼴이 `MesloLGS NF` 로 안 바뀐 것.
위의 폰트 설치 단계 다시 확인.

### `chsh` 비밀번호 물어보고 안 바뀜

```bash
sudo chsh -s $(which zsh) $USER
```

수동으로 한 번 더 실행. 그래도 안 되면 `/etc/passwd` 의 본인 라인 마지막을 `/bin/zsh` 로 직접 수정.

### `p10k configure` 다시 띄우고 싶음

```bash
p10k configure
```

### 설정 다 날리고 처음부터 다시

```bash
rm -rf ~/.oh-my-zsh ~/.zshrc ~/.p10k.zsh
```

그 후 스크립트 재실행.
