FROM node:18-alpine

WORKDIR /app

# 复制 package.json 并安装依赖
COPY package*.json ./
RUN npm install

# 复制仿真器代码
COPY . .

# 暴露可视化端口
EXPOSE 3030

# 默认运行仿真器
CMD ["node", "index.js"]
