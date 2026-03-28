FROM node:18-alpine

WORKDIR /app

# 复制 package.json 并安装依赖
COPY package*.json ./
RUN npm install

# 复制仿真器代码
COPY . .

# 仅仿真器 core（本仓库不提供前端可视化服务）
# 如需控制接口，默认 controlServer 端口为 9999（可在配置里修改）

# 默认运行仿真器
CMD ["node", "index.js"]
