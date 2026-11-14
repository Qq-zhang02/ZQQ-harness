/**
 * 泛型注册表（模块化架构重构 §4.1）：按键注册/注销，register 返回精确 disposer
 * （学 DSH/Cordis "注册即 effect、可逆" 的思路，零依赖手写）。
 * 键字段显式给出：常规定义用 "name"；以其他字段为键的定义在类型与实例化处写明
 * （ProviderFormatDef → "format"，SandboxBackendDef → "id"）。
 * all() 按键值稳定排序——token 计数、schema 输出、契约测试都依赖字节稳定；
 * 重复注册抛错（与 ToolRegistry 的静默覆盖不同：MCP 工具不经此 Registry）。
 */
export type Disposable = () => void;

export class Registry<T extends object, K extends keyof T> {
  private items = new Map<string, T>();

  private readonly keyField: K;

  constructor(keyField: K) {
    this.keyField = keyField;
  }

  private keyOf(item: T): string {
    return String(item[this.keyField]);
  }

  register(item: T): Disposable {
    const key = this.keyOf(item);
    if (this.items.has(key)) throw new Error(`重复注册：${key}`);
    this.items.set(key, item);
    return () => {
      this.items.delete(key);
    };
  }

  get(key: string): T | undefined {
    return this.items.get(key);
  }

  /** 取不到抛错：缺依赖/未注册是装配错误，必须显式失败而不是静默 undefined。 */
  require(key: string): T {
    const item = this.items.get(key);
    if (!item) throw new Error(`注册表中不存在：${key}`);
    return item;
  }

  all(): T[] {
    return [...this.items.values()].sort((a, b) => this.keyOf(a).localeCompare(this.keyOf(b)));
  }

  names(): string[] {
    return this.all().map((t) => this.keyOf(t));
  }
}
