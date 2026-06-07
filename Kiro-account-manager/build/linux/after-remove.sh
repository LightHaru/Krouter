#!/bin/bash

# Electron deb 包卸载后清理脚本

APP_NAME="Krouter"
APP_DIR_NOSPACE="krouter"
OPT_DIR="/opt/${APP_NAME}"
OPT_DIR_NOSPACE="/opt/${APP_DIR_NOSPACE}"

# 移除软链接
if [ -L "${OPT_DIR}" ]; then
  rm -f "${OPT_DIR}"
fi

# 移除无空格目录
if [ -d "${OPT_DIR_NOSPACE}" ]; then
  rm -rf "${OPT_DIR_NOSPACE}"
fi
