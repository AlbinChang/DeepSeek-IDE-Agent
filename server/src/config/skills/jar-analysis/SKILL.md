---
name: jar-analysis
description: JAR/WAR/AAR/CLASS 等 Java 二进制归档的解包、结构与内部逻辑分析规范。涉及 jar 包、反编译、查看 class、分析依赖包、理解第三方库内部逻辑时使用。
triggers:
  - jar
  - war
  - aar
  - jar包
  - jar 包
  - 反编译
  - decompile
  - javap
  - class 文件
  - 字节码
  - bytecode
  - 依赖包
---

# JAR 包分析规范

## 0. 铁律

- **禁止用 `read_file` / `read_file_by_byte` 直接读 `.jar` / `.war` / `.class`**：它们是二进制归档，读出来只会是乱码或被截断。
- **禁止只凭文件名、目录名或 pom 依赖猜测内部实现**：必须解包后基于真实内容下结论。
- 解包目标只能是工作区 `.temp/jar-<name>/`，禁止污染 `src/`、`docs/` 等业务目录；最终分析报告才写入交付目录。
- 解包前先看清单（`jar tf`），不要一上来就全量解压几万个 class。

## 1. 工具探测（按优先级）

1. `jar tf <file>.jar` —— JDK 自带，最优先。
2. `jar` 不在 PATH 但在 JAVA_HOME 下：`& "$env:JAVA_HOME\bin\jar.exe" tf <file>.jar`。
3. 无 JDK 时，jar 本质是 zip，用 PowerShell 解：
   ```powershell
   Copy-Item x.jar .temp/x.zip -Force
   Expand-Archive -LiteralPath .temp/x.zip -DestinationPath .temp/jar-x -Force
   ```
   或 `[System.IO.Compression.ZipFile]::ExtractToDirectory("<绝对路径>/x.jar", "<绝对路径>/.temp/jar-x")`。
4. 禁止用第三方 GUI 解压工具的截图或口头描述代替实际解包分析。

## 2. 结构侦察（先看清单，再决定解什么）

```powershell
jar tf app.jar > .temp/jar-app/filelist.txt
```

重点看：

| 位置 | 含义 |
| --- | --- |
| `META-INF/MANIFEST.MF` | `Main-Class`、`Start-Class`、`Class-Path`、`Implementation-Version` |
| `BOOT-INF/classes/` | Spring Boot fat jar 的业务代码 |
| `BOOT-INF/lib/` | Spring Boot 内嵌依赖 jar（嵌套包，需单独解压） |
| `WEB-INF/classes/`、`WEB-INF/lib/` | WAR 结构 |
| `META-INF/services/*` | SPI 扩展点，说明可插拔实现 |
| `META-INF/maven/**/pom.properties` | 依赖坐标与版本（groupId:artifactId:version） |
| `*.properties` / `*.yml` / `*.xml` | 默认配置、Bean 定义、映射文件 |

由此先判断：入口类是什么、用了什么框架、是否 fat jar、是否混淆（类名变成 `a/b/c`）。

## 3. 解压

```powershell
New-Item -ItemType Directory -Force -Path .temp/jar-app | Out-Null
Push-Location .temp/jar-app
jar xf "<绝对路径>/app.jar"
Pop-Location
```

- 只解需要的部分：`jar xf app.jar BOOT-INF/classes/com/foo/Bar.class META-INF/MANIFEST.MF`
- 嵌套依赖（`BOOT-INF/lib/*.jar`）要逐个解到同级目录再分析。
- 中文文件名乱码：`jar` 用平台编码，Windows 下可加 `-J-Dfile.encoding=UTF-8`；仍乱码改用 `ZipFile` 解压后按 UTF-8 读取。

## 4. 理解内部逻辑（逐层递进，不要停在列清单）

1. **清单层**：manifest → 入口类、版本、类路径依赖。
2. **结构层**：包结构 → 模块划分；`META-INF/services` → 扩展点；配置文件 → 默认行为与开关。
3. **符号层**：`javap -p -classpath . com.foo.Bar` 看字段与方法签名；`javap -p -c` 看字节码指令与常量池（可判断调用了哪些 API）。
4. **源码层**（需要可读实现时反编译）：
   - CFR：`java -jar .temp/cfr.jar app.jar --outputdir .temp/jar-app/src`
   - 下载走国内镜像：`https://maven.aliyun.com/repository/public/org/benf/cfr/0.152/cfr-0.152.jar`
   - Procyon / Fernflower 同理；**禁止**把用户 jar 上传到在线反编译网站。
5. **调用链层**：从入口类或被调 API 出发，顺方法调用与配置装配追踪，形成「类 → 方法 → 关键分支」链路。
6. **结论层**：明确写出入口、关键类、主流程、依赖版本、风险点（硬编码密钥、反射动态加载、JNI、危险反序列化）。

## 5. 常见任务模板

| 用户意图 | 执行路径 |
| --- | --- |
| 这个 jar 是干什么的 | 清单 + manifest + 包结构 + 入口类 + 核心类职责 |
| 某功能怎么实现的 | 定位入口/接口 → `javap` 或反编译目标类 → 追调用链 → 输出流程图式说明 |
| 依赖了什么、版本冲突吗 | 解 `BOOT-INF/lib` 或读 `pom.properties`，输出 groupId:artifactId:version 表 |
| 有没有安全问题 | 查硬编码密钥、`Runtime.exec`、JNDI、反序列化、反射加载、越权配置 |
| 能不能改/替换某个类 | 说明改动点与影响面，给出重新打包步骤（`jar cf`/`jar uf`），禁止直接改二进制 |

## 6. 交付要求

- 报告写清：文件路径、大小、SHA256、清单摘要、入口类、依赖版本表、关键流程、证据位置（class 全名 / 配置键 / 行号）。
- 每条结论必须能追溯到实际解包内容；无法确认的标注「待验证」，禁止凭经验臆断。
- 分析完成后清理 `.temp/jar-*` 中间产物（用户要求保留时除外）。
