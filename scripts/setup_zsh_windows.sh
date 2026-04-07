#!/usr/bin/env bash
#
# Windows (WSL2 Ubuntu) 용 zsh 환경 설치 스크립트
#
# 사용 전 준비
# 1. Windows PowerShell 관리자 권한으로 실행 후
#       wsl --install
#    Ubuntu 설치 + 재부팅
# 2. Ubuntu 실행해서 사용자 계정 만들기
# 3. Ubuntu 안에서 이 스크립트 실행
#       bash setup_zsh_windows.sh
#
# 설치 항목
# - zsh
# - oh-my-zsh
# - powerlevel10k 테마 (사진같은 화살표 프롬프트)
# - zsh-autosuggestions (회색으로 자동 완성 미리 보여주는거)
# - zsh-syntax-highlighting (명령어 색칠)
# - MesloLGS NF 폰트 (사진의 아이콘 깨짐 방지, 별도 안내)

set -e

echo ">> 패키지 업데이트"
sudo apt update && sudo apt install -y zsh git curl fonts-powerline

echo ">> oh-my-zsh 설치"
if [ ! -d "$HOME/.oh-my-zsh" ]; then
  sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended
fi

ZSH_CUSTOM="${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}"

echo ">> powerlevel10k 테마 설치"
if [ ! -d "$ZSH_CUSTOM/themes/powerlevel10k" ]; then
  git clone --depth=1 https://github.com/romkatv/powerlevel10k.git "$ZSH_CUSTOM/themes/powerlevel10k"
fi

echo ">> zsh-autosuggestions 설치 (자동완성)"
if [ ! -d "$ZSH_CUSTOM/plugins/zsh-autosuggestions" ]; then
  git clone https://github.com/zsh-users/zsh-autosuggestions "$ZSH_CUSTOM/plugins/zsh-autosuggestions"
fi

echo ">> zsh-syntax-highlighting 설치 (명령어 색칠)"
if [ ! -d "$ZSH_CUSTOM/plugins/zsh-syntax-highlighting" ]; then
  git clone https://github.com/zsh-users/zsh-syntax-highlighting.git "$ZSH_CUSTOM/plugins/zsh-syntax-highlighting"
fi

echo ">> .zshrc 설정"
sed -i 's|^ZSH_THEME=.*|ZSH_THEME="powerlevel10k/powerlevel10k"|' "$HOME/.zshrc"
sed -i 's|^plugins=.*|plugins=(git zsh-autosuggestions zsh-syntax-highlighting)|' "$HOME/.zshrc"

echo ">> 기본 셸을 zsh 로 변경"
sudo chsh -s "$(which zsh)" "$USER"

echo ""
echo "=================================================="
echo " 설치 완료"
echo "=================================================="
echo ""
echo " 다음 단계"
echo " 1. 터미널 닫고 다시 열기"
echo " 2. powerlevel10k 설정 마법사가 자동으로 뜸"
echo "    (안 뜨면 'p10k configure' 입력)"
echo ""
echo " 폰트 (아이콘 깨짐 방지)"
echo " - https://github.com/romkatv/powerlevel10k-media 에서"
echo "   MesloLGS NF Regular/Bold/Italic/Bold Italic 4개 다운로드"
echo " - Windows 에 설치 후 Windows Terminal 설정에서 폰트 변경"
echo "   (Ubuntu 프로필 > 모양 > 글꼴 > MesloLGS NF)"
echo ""
