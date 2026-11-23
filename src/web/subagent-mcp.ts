/**
 * 子代理家族七件套之八：worker 共享 MCP 工具装配（docs/6 P2 路线 A；docs/42 自 subagent-worker.ts
 * 移入，纯移动——该文件要装下只读子代理装配/台账回填入口/预警线提示，受家族单文件 ≤400 行哨兵约束）。
 * 会话级共享连接：每会话只连一次（rt.workerMcp 的 promise 缓存），工具快照复制给每个 worker 的
 * 独立 registry；整体失败降级为不带 mcp__ 工具（不因 MCP 故障拒派）。只读子代理不装 MCP 工具
 * （见 mountWorkerAgent——MCP 工具不走沙箱，无法保证只读）。
 */
import { join } from "node:path";
import { loadMcpConfig } from "../mcp/manager.ts";
import { ToolRegistry, type Tool } from "../tools/registry.ts";
import type { SessionRuntime } from "../core/host.ts";
import type { SessionShell } from "./session-runtime.ts";

/**
 * worker 共享 MCP 工具（docs/6 P2 路线 A）：首个 runWorker 懒加载。连接挂在本会话的
 * rt.mcp 上——协调者会话（唯一会派 worker 的形态）该 manager 闲置（createRuntime 与
 * bindWorkspace 对 coordinator 都跳过 apply，D3），专供 worker 正好；进程退出随
 * server.ts 既有 rt.mcp.stop() 统一回收，与普通会话同等待遇（server.ts 零改动）。
 * 工具注册进一次性模板 registry 再拍快照：McpManager.apply 是「一次性 apply 到一个
 * registry」的形态，快照复制给每个 worker 的独立 registry（execute 闭包无状态，
 * 共享同一批连接——每 server 一个进程，不是每 worker 一个）。
 * 每会话只连一次（rt.workerMcp 的 promise 缓存：同轮多 agent_task 并行首派不会双连，docs/15）；
 * 单服务器失败由 apply 内建隔离，整体异常降级为 null（worker 照旧不带 mcp__ 工具，
 * 不因 MCP 故障拒派）。红线不破：协调者自己的 rt.registry 仍仅 agent_task(s)、
 * 系统提示仍无 MCP 段（本函数不触碰它们）。
 * docs/20 修订：连接不再只等首个 worker 派发——协调者会话创建（createRuntime）与
 * bindWorkspace 会 fire-and-forget 预热本函数（「子代理系统提示词说明」段需要说明书；
 * 真机反馈：未预热时新会话首轮协调者对子代理 MCP 能力一无所知）。
 */
/** 失败重试前的宽限延迟（docs/32）：冷启动型服务器（如 godot-ai attach 先拉起后端再应答
 *  握手，健康检查上限可超过单次握手超时）首轮必超时——宽限一程后整体重连一次（stopAll
 *  幂等：已成功的服务器进程已在、秒连；失败者赶上后端就绪窗口）。仍失败才对本会话定局。 */
const WORKER_MCP_RETRY_DELAY_MS = 10_000;

export async function workerMcpToolsOf(sh: SessionShell, rt: SessionRuntime): Promise<readonly Tool[] | null> {
  rt.workerMcp ??= (async (): Promise<readonly Tool[] | null> => {
    try {
      const globalCfg = await loadMcpConfig([sh.globalMcpFile]);
      const wsCfg = rt.workspace ? await loadMcpConfig([join(rt.workspace.root, "mcp.json")]) : { mcpServers: {} };
      if (Object.keys(globalCfg.mcpServers).length === 0 && Object.keys(wsCfg.mcpServers).length === 0) return null;
      const template = new ToolRegistry();
      try {
        await rt.mcp.apply(globalCfg, wsCfg, template);
        // docs/32：失败服务器不判死刑（真机实证：godot 冷启动 > 20s 握手超时被记入 failures
        // 永不重试，而 1 分钟后的普通对话因后端已被拉起而秒连——表现为「只有普通对话注入了」）
        if (rt.mcp.failedServers().length > 0) {
          await new Promise((r) => setTimeout(r, WORKER_MCP_RETRY_DELAY_MS));
          await rt.mcp.apply(globalCfg, wsCfg, template);
        }
      } catch (e) {
        console.warn(`[subagent] worker MCP 装配失败（降级为不带 mcp__ 工具）：${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
      // docs/20：MCP 说明书随协调者的「子代理系统提示词说明」段注入——连接收尾（含重试）
      // 后重建一次协调者系统提示（本 promise 缓存保证只触发一次；协调者 rt.agent 在任何
      // 派发发生前已装配就位）。独立 try：刷新异常绝不影响 worker 拿工具（测试桩 agent 可能缺该方法）。
      try {
        rt.agent?.refreshSystemPrompt();
      } catch {
        /* 刷新失败不阻断 worker 装配 */
      }
      return template.list();
    } catch (e) {
      // docs/32：整体意外拒绝也降级 null——??= 缓存 rejected promise 一旦发生，后续全部
      // worker 装配（await 处）都会失败且无重试入口。
      console.warn(`[subagent] worker MCP 装配失败（降级为不带 mcp__ 工具）：${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  })();
  return rt.workerMcp;
}

