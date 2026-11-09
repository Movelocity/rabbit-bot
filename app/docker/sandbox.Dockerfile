# poolchat 沙盒镜像：通用 shell + node + python，给 sb run 用。
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

# 沙盒内的 rb 客户端：业务数据走宿主 REST API，文件/shell 直接操作 /work。
COPY rb.mjs /usr/local/bin/rb
COPY skills.py /usr/local/bin/skills
RUN chmod +x /usr/local/bin/rb /usr/local/bin/skills && /usr/local/bin/rb help >/dev/null && /usr/local/bin/skills >/dev/null
