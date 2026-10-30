# Google插件（Chrome 扩展集合）

团队自用的 Chrome 扩展统一放这里，**clone 一次，以后 `git pull` 就更新**，
不用再「打包 zip → 发给人 → 对方解压 → 加载」。

仓库地址：`https://github.com/sunshine1130/misc-dev-kit`

> 🔓 **本仓库是公开仓库，无需 GitHub 账号即可 clone。**
> 因此请只提交扩展运行必需的文件；**不要**往这里放内部文档、需求资料、账号口令、内网拓扑等资料。
> （扩展代码本身包含内网域名与接口路径，那是它工作所必需的。）

## 扩展清单

| 扩展 | 用途 |
| --- | --- |
| `auth-resource-sync` | 权限资源跨环境同步（路由/菜单/按钮/字段/数据权限）；用户账号的应用+角色跨环境/同环境同步，支持执行后撤销 |
| `dict-sync` | 数据字典同步（类型 + 值）；生产/未知域名只读，可在面板头部两步开启写入 |
| `fba-segment-matcher` | FBA 分段匹配 |

---

## 一、首次安装（一次性）

**1. 克隆到固定目录**（不需要登录）

```bash
git clone https://github.com/sunshine1130/misc-dev-kit.git D:\tools\Google插件
```

路径**不要随便改**——Chrome 记住的是加载时那个目录，改名后要重新加载一次。

**2. 加载到 Chrome**

1. 打开 `chrome://extensions`
2. 右上角打开 **开发者模式**
3. 点 **加载已解压的扩展程序**
4. 选择 **子目录**，例如 `D:\tools\Google插件\auth-resource-sync`
   （⚠️ 不要选仓库根目录，根目录没有 `manifest.json`）
5. 需要哪个扩展就重复第 3–4 步

---

## 二、日常更新

双击仓库根目录的 **`更新插件.bat`**，它会 `git pull` 并提示下一步。

或者手动：

```bash
cd D:\tools\Google插件
git pull
```

然后回到 `chrome://extensions`，在对应扩展卡片上点 **「重新加载」（⟳）**。

> **只 pull 不重载 = 没更新。** 这一步必须手动点（Chrome 不允许脚本重载扩展）。

重载后扩展卡片上会显示版本号，可据此确认是否为最新版。

---

## 三、维护者发布新版本

```bash
cd C:\项目\Google插件
# 1. 改代码
# 2. 改对应扩展的 manifest.json 里的 "version"，例如 1.0.0 -> 1.1.0
git add .
git commit -m "feat(auth-resource-sync): 说明本次改了什么"
git push
```

然后在群里说一句：「已更新到 x.y.z，跑一下 `更新插件.bat`」。

> 推送需要 GitHub 身份。若弹窗登录失败，可改用 PAT（GitHub → Settings → Developer settings →
> Personal access tokens，勾选 `repo` 权限，token 只显示一次）：
> `git remote set-url origin https://<你的PAT>@github.com/sunshine1130/misc-dev-kit.git`

---

## 四、常见坑

**改了扩展但页面没变化**

1. 确认 `chrome://extensions` 上该扩展的版本号是否已是最新，不是就点「重新加载」
2. 确认面板出现在当前页——扩展只在权限管理页面激活（URL 含 `/MF_auth/`）

**pull 很慢或超时**

GitHub 在国内访问偶尔不稳，重试一次通常就好；持续不行可挂代理后再 pull：

```bash
git config --global http.proxy http://127.0.0.1:7890   # 用完记得 unset
```

**clone 很慢**

别往仓库里放大图。仓库已把图标压到 13 KB 以内，整个扩展约 0.1 MB；新增图片请先压缩。

---

## 五、安全边界（重要）

- **扩展只在公司域名生效**：`auth-resource-sync` 与 `dict-sync` 的 `content_scripts.matches`、
  `host_permissions`、`web_accessible_resources` 都已收窄为 `*.joyintoy.cn` 加
  `localhost` / `127.0.0.1`，不再向任意网站注入脚本。
- **生产默认只读**（两个扩展同一套规则）：可写白名单为**宿主首段含**
  `dev` / `test` / `sit` / `uat` 的环境（形如 `test-zt` / `uat-zt` / `mdmtest` 都算），
  另放行 `localhost`、`127.0.0.1`；**其余一律禁止写入**，采集与查看不受影响。
  环境按宿主识别：`test-zt.joyintoy.cn` = 测试、`uat-zt.joyintoy.cn` = 验收测试、
  `mdmdev-*` = 开发、`stg-*` = 预发；**公司主域下不带环境标记的宿主就是生产**
  （`auth.joyintoy.cn`、`www.joyintoy.cn`、`zt.joyintoy.cn` 都是），
  非公司域的陌生网站标为"未知"，同样只读 —— 即**默认拒绝**。
  需要在生产上写时，可在面板头部点「开启写入」，需**两步确认**（确认后果 + 手动输入完整域名），
  且**只对当前环境、当前页面会话有效，刷新即恢复只读**。
- **执行前校验环境匹配**：快照里的用户/应用/角色/资源 ID 只在采集它的环境里有意义。
  当前页面环境与目标快照环境不一致时**禁止写入**并明确提示，资源同步与用户同步都受此约束。
- **大批量移除二次确认**：单次移除超过 20 项权限时，除常规确认外还需**手动输入目标账号名**。

> 可写环境白名单在 `auth-resource-sync/perm-map.js` 与 `dict-sync/env-guard.js` 的
> `WRITABLE_LABEL_RE`，阈值在 `auth-resource-sync/content.js` 的 `REMOVAL_CONFIRM_THRESHOLD`。
> 改动前请先看清注释。**两个扩展各有一份实现且必须保持一致**（独立加载、无构建步骤，
> 没法共享文件）：`dict-sync/tests/env-guard-consistency.test.cjs` 会同时加载两份并逐项比对，
> 改任意一份都必须同步改另一份，否则测试变红。

---

## 六、待优化项（维护者）

- [x] ~~收窄权限~~ —— 已完成，见第五节。
- [x] ~~`icons/icon128-new.png` 未被任何文件引用~~ —— 已删除（git 历史里可恢复）。
- [x] ~~清理运行时消息里的死代码~~ —— 三个无人调用的处理器已删除，
      只保留 `popup → background` 的 `CLEAR_DATA` 一条清除路径。
- [x] ~~扩展面板显示自身版本号~~ —— 已完成：面板头部、popup、帮助页三处都从
      `chrome.runtime.getManifest()` 读，不再手抄（原先 popup 写死 `v1.0`、帮助页写死 `v1.1`，
      早已和 manifest 对不上）。
- [ ] 撤销只覆盖**最近一次**用户权限同步。做多步历史前要先定清楚"撤销的撤销"是什么语义，
      否则会变成一个没人敢点的按钮；资源同步按节点 upsert，没有整棵树快照，暂时不提供撤销。
