# xiaoli（小李）

> 一个住在终端里的 AI 同事。你交代任务、回答追问，它自己干活。

## 安装

```bash
npm install -g xiaoli
```

## 配置

```bash
# 设置 DeepSeek API key
xiaoli config set api-key sk-xxx
```

## 使用

```bash
# 启动新任务
xiaoli "修复ERP订单查询慢的问题"

# 查看进度
xiaoli status

# 继续上次的任务
xiaoli continue
```

## 文档

- [产品定位](docs/00_产品定位.md)
- [交互流程设计](docs/01_交互流程设计.md)
- [技术架构设计](docs/02_技术架构设计.md)
