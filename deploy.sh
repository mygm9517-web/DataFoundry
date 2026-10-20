#!/bin/bash

# DataFoundry 部署脚本
# 用于在服务器上部署和启动项目

set -e

echo "======================================"
echo "DataFoundry Docker 部署脚本"
echo "======================================"

# 检查 Docker 是否安装
if ! command -v docker &> /dev/null; then
    echo "错误: Docker 未安装，请先安装 Docker"
    exit 1
fi

# 检查 Docker Compose 是否安装
if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
    echo "错误: Docker Compose 未安装，请先安装 Docker Compose"
    exit 1
fi

# 停止并删除旧容器
echo "停止旧容器..."
docker-compose down || true

# 构建镜像
echo "构建 Docker 镜像..."
docker-compose build

# 创建 storage 目录
echo "创建存储目录..."
mkdir -p storage/metadata storage/bigscreen

# 复制生产环境配置
if [ ! -f .env ]; then
    echo "复制生产环境配置..."
    cp .env.production .env
    echo "请编辑 .env 文件，填写正确的 API Key 和数据库配置"
fi

# 启动容器
echo "启动容器..."
docker-compose up -d

# 等待服务启动
echo "等待服务启动..."
sleep 10

# 检查服务状态
echo "检查服务状态..."
docker-compose ps

echo ""
echo "======================================"
echo "部署完成！"
echo "======================================"
echo "Web 访问地址: http://${DATAFOUNDRY_PUBLIC_HOST:-localhost}:3000"
echo "API 地址: http://${DATAFOUNDRY_PUBLIC_HOST:-localhost}:8787"
echo ""
echo "查看日志: docker-compose logs -f"
echo "停止服务: docker-compose down"
echo "重启服务: docker-compose restart"
echo "======================================"
