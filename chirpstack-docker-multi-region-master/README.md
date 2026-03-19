# ChirpStack Docker 示例

本仓库包含了使用 [Docker Compose](https://docs.docker.com/compose/) 搭建 [ChirpStack](https://www.chirpstack.io) 开源 LoRaWAN 网络服务器（v4）的基础框架。

**注意：** 请将此 `docker-compose.yml` 文件作为测试的起点，但请注意，对于生产环境使用可能需要进行修改。

## 目录结构

* `docker-compose.yml`：包含所有服务的 docker-compose 文件
* `configuration/chirpstack`：包含 ChirpStack 配置文件的目录
* `configuration/chirpstack-gateway-bridge`：包含 ChirpStack Gateway Bridge 配置的目录
* `configuration/mosquitto`：包含 Mosquitto（MQTT 代理）配置的目录
* `configuration/postgresql/initdb/`：包含 PostgreSQL 初始化脚本的目录

## 配置

此设置已预配置支持所有区域。您可以将 ChirpStack Gateway Bridge 实例（v3.14.0+）连接到 MQTT 代理（端口 1883）或连接 Semtech UDP 数据包转发器。请注意：

* 您必须在 MQTT 主题前添加区域前缀。
  请查看 `configuration/chirpstack` 中的区域配置文件以获取主题前缀列表（例如 eu868、us915_0、au915_0、as923_2 等）。
* 已配置 protobuf 编组器。

此设置包含三个 ChirpStack Gateway Bridge 实例：
1. 一个配置用于处理 Semtech UDP 数据包转发器数据（端口 1700）
2. 一个配置用于处理 Basics Station 协议（端口 3001）
3. 一个配置用于 au915_2 区域（端口 1701）

### 重新配置区域

ChirpStack 默认启用了每个区域的至少一个配置。您可以在 `configuration/chirpstack/chirpstack.toml` 中找到 `enabled_regions` 列表。
`enabled_regions` 中的每个条目都引用 `region_XXX.toml` 文件中的 `id`。该 `region_XXX.toml` 还包含 `topic_prefix` 配置，您需要配置 ChirpStack Gateway Bridge UDP 实例（见下文）。

#### ChirpStack Gateway Bridge (UDP)

在 `docker-compose.yml` 文件中，您必须将 `INTEGRATION__..._TOPIC_TEMPLATE` 配置中的 `eu868` 前缀替换为您想要使用的区域的 MQTT `topic_prefix`（例如 `us915_0`、`au915_0`、`in865` 等）。

对于 au915_2 区域，配置已经设置好：
```yaml
chirpstack-gateway-bridge-au915:
  image: chirpstack/chirpstack-gateway-bridge:4
  ports:
    - "1701:1700/udp"
  environment:
    - INTEGRATION__MQTT__EVENT_TOPIC_TEMPLATE=au915_2/gateway/{{ .GatewayID }}/event/{{ .EventType }}
    - INTEGRATION__MQTT__COMMAND_TOPIC_TEMPLATE=au915_2/gateway/{{ .GatewayID }}/command/#
    - INTEGRATION__MQTT__STATE_TOPIC_TEMPLATE=au915_2/gateway/{{ .GatewayID }}/state/{{ .StateType }}
```

#### ChirpStack Gateway Bridge (Basics Station)

在 `docker-compose.yml` 文件中，您必须更新 ChirpStack Gateway Bridge 实例使用的配置文件。默认为 `chirpstack-gateway-bridge-basicstation-eu868.toml`. 有关可用配置文件，请参见 `configuration/chirpstack-gateway-bridge` 目录。

## 数据持久化

PostgreSQL 和 Redis 数据保存在 Docker 卷中，请参见 `docker-compose.yml` 中的 `volumes` 定义。

## 系统要求

在使用此 `docker-compose.yml` 文件之前，请确保已安装 [Docker](https://www.docker.com/community-edition)。

## 导入设备仓库

要导入 [lorawan-devices](https://github.com/TheThingsNetwork/lorawan-devices) 仓库（可选步骤），请运行以下命令：

```bash
make import-lorawan-devices
```

这将克隆 `lorawan-devices` 仓库并执行 ChirpStack 的导入命令。
请注意，此步骤需要安装 `make` 命令。

**注意：** 克隆的是 `lorawan-devices` 仓库的较旧快照，因为最新版本不再包含 `LICENSE` 文件。

## 使用方法

要启动 ChirpStack，只需运行：

```bash
$ docker compose up -d
```

在所有组件初始化和启动后，您应该能够在浏览器中打开 http://localhost:8080/。

该示例包含 [ChirpStack REST API](https://github.com/chirpstack/chirpstack-rest-api)。
您应该能够通过打开 http://localhost:8090 访问 UI。

**注意：** 建议使用 [gRPC](https://www.chirpstack.io/docs/chirpstack/api/grpc.html) 接口而不是 [REST](https://www.chirpstack.io/docs/chirpstack/api/rest.html) 接口。

## 端口配置

默认暴露以下端口：

- 8080：ChirpStack Web 界面
- 8090：ChirpStack REST API
- 1883：MQTT 代理
- 1700：UDP 网关桥接（默认）
- 1701：UDP 网关桥接（au915_2）
- 3001：Basics Station 网关桥接
- 8086：InfluxDB
- 3000：Grafana
- 1880：Node-RED

## Cayenne LPP 解码器

此设置包含适用于 ChirpStack v4 的 Cayenne LPP（低功耗负载）解码器。有关解码器的详细信息，请参阅 [Cayenne LPP 解码器文档](#chirpstack-v4-cayenne-lpp-decoder)。
