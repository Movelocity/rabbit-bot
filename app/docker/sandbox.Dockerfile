# poolchat 沙盒镜像：通用 shell + node + python，给 sandbox_run 用。
# 边界不在这里，在 docker run 的参数里（见 src/core/sandbox-shell.ts）：
#   --network none / --read-only / --cap-drop ALL / 只挂 data/sandbox → /work
FROM node:22-alpine

RUN apk add --no-cache \
      python3 \
      py3-pip \
      git \
      curl \
      bash \
      jq \
      ripgrep \
      ca-certificates \
 && python3 --version && git --version && jq --version && rg --version | head -1 && bash --version | head -1

# 根文件系统只读，HOME 指到 tmpfs，pip --user / git 的全局配置才有地方落。
# PIP_USER + PIP_BREAK_SYSTEM_PACKAGES：让 `pip install x` 直接成功（装进 /tmp/home/.local，容器重建即失效；
# 想长期留着就用 python3 -m venv /work/.venv）。
ENV HOME=/tmp/home \
    PIP_USER=1 \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    PYTHONDONTWRITEBYTECODE=1
WORKDIR /work
