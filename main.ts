import { App, ItemView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf, setIcon, stringifyYaml } from "obsidian";

const VIEW_TYPE = "financial-space-dashboard";
const DATA_FOLDER = "Финансовое пространство";
const TRANSACTIONS_FOLDER = `${DATA_FOLDER}/Операции`;

type TransactionKind = "expense" | "income" | "transfer";
interface Transaction { id: string; kind: TransactionKind; amount: number; category: string; account: string; note: string; date: string; }
interface Account { id: string; name: string; balance: number; }
interface Budget { category: string; limit: number; }
interface PlannedPayment { id: string; title: string; amount: number; day: number; }
interface FinancialSpaceSettings {
  accounts: Account[];
  transactions: Transaction[];
  budgets: Budget[];
  plannedPayments: PlannedPayment[];
  expectedIncome: number;
  logsFolder: string;
  logFileTemplate: string;
}

const DEFAULT_SETTINGS: FinancialSpaceSettings = {
  accounts: [{ id: "card", name: "Основная карта", balance: 0 }],
  transactions: [],
  budgets: [
    { category: "Еда", limit: 12000 }, { category: "Транспорт", limit: 3000 },
    { category: "Дом", limit: 5000 }, { category: "Развлечения", limit: 4000 }
  ],
  plannedPayments: [],
  expectedIncome: 0,
  logsFolder: `${TRANSACTIONS_FOLDER}/{month}`,
  logFileTemplate: "{date}-{kind}-{category}-{id}"
};

const categoryIcons: Record<string, string> = {
  "Еда": "utensils", "Транспорт": "bus", "Дом": "house", "Развлечения": "gamepad-2",
  "Здоровье": "heart-pulse", "Учёба": "graduation-cap", "Подписки": "repeat-2", "Другое": "circle"
};

const rubles = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 0 });
const money = (value: number) => rubles.format(value);
const dateKey = (date = new Date()) => date.toISOString().slice(0, 10);
const monthKey = (date = new Date()) => date.toISOString().slice(0, 7);

class MarkdownStorage {
  constructor(private app: App) {}
  private async ensureFolder(path: string) {
    if (!this.app.vault.getAbstractFileByPath(path)) await this.app.vault.createFolder(path);
  }
  private frontmatter(data: unknown, title: string, body = "") {
    return `---\n${stringifyYaml(data)}---\n\n# ${title}\n${body ? `\n${body}\n` : ""}`;
  }
  private transactionContent(transaction: Transaction) {
    const title = `${transaction.kind === "income" ? "Доход" : "Расход"}: ${transaction.category} · ${money(transaction.amount)}`;
    return this.frontmatter(transaction, title, transaction.note || "Добавлено из панели «Финансовое пространство».");
  }
  async saveTransaction(transaction: Transaction, settings: FinancialSpaceSettings) {
    const logsFolder = (settings.logsFolder.trim() || DEFAULT_SETTINGS.logsFolder)
      .replaceAll("{month}", transaction.date.slice(0, 7)).replace(/\/$/, "");
    const rootSegments = logsFolder.split("/").filter(Boolean);
    let folder = "";
    for (const segment of rootSegments) { folder = folder ? `${folder}/${segment}` : segment; await this.ensureFolder(folder); }
    const safeId = transaction.id.slice(0, 8);
    const filename = (settings.logFileTemplate.trim() || DEFAULT_SETTINGS.logFileTemplate)
      .replaceAll("{date}", transaction.date).replaceAll("{month}", transaction.date.slice(0, 7))
      .replaceAll("{kind}", transaction.kind).replaceAll("{category}", transaction.category)
      .replaceAll("{account}", transaction.account).replaceAll("{amount}", String(transaction.amount)).replaceAll("{id}", safeId)
      .replace(/[\\/:*?"<>|]/g, "-").replace(/^\.+/, "") || safeId;
    const path = `${logsFolder}/${filename}.md`;
    const content = this.transactionContent(transaction);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) await this.app.vault.modify(file, content); else await this.app.vault.create(path, content);
  }
}

export default class FinancialSpacePlugin extends Plugin {
  settings!: FinancialSpaceSettings;
  storage!: MarkdownStorage;

  async onload() {
    this.storage = new MarkdownStorage(this.app);
    await this.loadSettings();
    this.registerView(VIEW_TYPE, leaf => new FinancialSpaceView(leaf, this));
    this.addRibbonIcon("wallet-cards", "Открыть Финансовое пространство", () => void this.activateView());
    this.addCommand({ id: "open-dashboard", name: "Открыть панель", callback: () => void this.activateView() });
    this.addCommand({ id: "add-expense", name: "Добавить расход", callback: () => new TransactionModal(this.app, this, "expense").open() });
    this.addCommand({ id: "add-income", name: "Добавить доход", callback: () => new TransactionModal(this.app, this, "income").open() });
    this.addSettingTab(new FinancialSpaceSettingTab(this.app, this));
  }

  async loadSettings() {
    const saved = await this.loadData() as Partial<FinancialSpaceSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...saved, transactions: saved?.transactions ?? [] };
  }
  async saveSettings() { await this.saveData(this.settings); this.refreshViews(); }
  async addTransaction(transaction: Transaction) { this.settings.transactions.push(transaction); await this.storage.saveTransaction(transaction, this.settings); await this.saveSettings(); }
  refreshViews() { this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach(leaf => (leaf.view as FinancialSpaceView).render()); }
  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) leaf = workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    await workspace.revealLeaf(leaf);
  }
  currentTransactions() { return this.settings.transactions.filter(t => t.date.startsWith(monthKey())); }
  accountBalance() { return this.settings.accounts.reduce((sum, account) => sum + account.balance, 0); }
  plannedRemaining() {
    const today = new Date().getDate();
    return this.settings.plannedPayments.filter(p => p.day >= today).reduce((sum, p) => sum + p.amount, 0);
  }
  available() { return this.accountBalance() + this.settings.expectedIncome - this.plannedRemaining(); }
}

class FinancialSpaceView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private plugin: FinancialSpacePlugin) { super(leaf); }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "Финансовое пространство"; }
  getIcon() { return "wallet-cards"; }
  async onOpen() { this.render(); }

  button(parent: HTMLElement, icon: string, text: string, action: () => void) {
    const button = parent.createEl("button", { cls: "mod-cta" }); setIcon(button, icon); button.appendText(text); button.onclick = action;
  }
  render() {
    const el = this.contentEl; el.empty(); el.addClass("financial-space-view");
    const header = el.createDiv({ cls: "fs-header" });
    const title = header.createDiv(); title.createEl("h1", { text: "Финансовое пространство", cls: "fs-title" });
    title.createDiv({ text: "Спокойный взгляд на деньги в этом месяце", cls: "fs-subtitle" });
    const actions = header.createDiv({ cls: "fs-actions" });
    this.button(actions, "arrow-down-circle", "Расход", () => new TransactionModal(this.app, this.plugin, "expense").open());
    this.button(actions, "arrow-up-circle", "Доход", () => new TransactionModal(this.app, this.plugin, "income").open());

    const available = this.plugin.available();
    const days = Math.max(1, new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate() - new Date().getDate() + 1);
    const hero = el.createDiv({ cls: "fs-hero" });
    hero.createDiv({ text: "Доступно до конца месяца", cls: "fs-eyebrow" });
    hero.createDiv({ text: money(available), cls: "fs-available" });
    hero.createDiv({ text: `Это примерно ${money(available / days)} в день · осталось ${days} дн.`, cls: "fs-hint" });

    const grid = el.createDiv({ cls: "fs-grid" });
    this.stat(grid, "На счетах", money(this.plugin.accountBalance()));
    this.stat(grid, "Запланировано", money(this.plugin.plannedRemaining()));
    this.stat(grid, "Ожидаемые доходы", money(this.plugin.settings.expectedIncome));
    this.renderBudgets(el);
    this.renderTransactions(el);
  }
  stat(parent: HTMLElement, label: string, value: string) { const card = parent.createDiv({ cls: "fs-card" }); card.createDiv({ text: label, cls: "fs-card-label" }); card.createDiv({ text: value, cls: "fs-card-value" }); }
  renderBudgets(parent: HTMLElement) {
    const section = parent.createDiv({ cls: "fs-section" }); section.createDiv({ text: "Бюджеты месяца", cls: "fs-section-title" });
    const month = this.plugin.currentTransactions();
    for (const budget of this.plugin.settings.budgets) {
      const spent = month.filter(t => t.kind === "expense" && t.category === budget.category).reduce((sum, t) => sum + t.amount, 0);
      const percent = budget.limit ? Math.min(100, spent / budget.limit * 100) : 0;
      const item = section.createDiv({ cls: "fs-budget" }); const top = item.createDiv({ cls: "fs-budget-top" });
      top.createSpan({ text: budget.category }); top.createSpan({ text: `${money(spent)} из ${money(budget.limit)}` });
      const progress = item.createDiv({ cls: `fs-progress ${spent > budget.limit ? "over" : ""}` }); progress.createDiv().style.width = `${percent}%`;
    }
    if (!this.plugin.settings.budgets.length) section.createDiv({ text: "Добавьте бюджеты в настройках плагина.", cls: "fs-empty" });
  }
  renderTransactions(parent: HTMLElement) {
    const section = parent.createDiv({ cls: "fs-section" }); section.createDiv({ text: "Последние операции", cls: "fs-section-title" });
    const entries = [...this.plugin.settings.transactions].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
    if (!entries.length) { section.createDiv({ text: "Пока нет операций. Добавьте первую трату — и прогноз оживёт.", cls: "fs-empty" }); return; }
    for (const t of entries) {
      const row = section.createDiv({ cls: "fs-row" }); const main = row.createDiv({ cls: "fs-row-main" }); const icon = main.createDiv({ cls: "fs-row-icon" }); setIcon(icon, categoryIcons[t.category] ?? "circle");
      const text = main.createDiv(); text.createDiv({ text: t.note || t.category, cls: "fs-row-name" }); text.createDiv({ text: `${t.category} · ${new Date(`${t.date}T12:00:00`).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}`, cls: "fs-row-meta" });
      row.createDiv({ text: `${t.kind === "income" ? "+" : "−"}${money(t.amount)}`, cls: t.kind === "income" ? "fs-income" : "fs-expense" });
    }
  }
}

class TransactionModal extends Modal {
  private amount = ""; private category = "Еда"; private account = ""; private note = ""; private date = dateKey();
  constructor(app: App, private plugin: FinancialSpacePlugin, private kind: TransactionKind) {
    super(app);
    this.account = plugin.settings.accounts[0]?.id ?? "";
    this.category = kind === "income" ? "Доход" : "Еда";
  }
  onOpen() {
    const { contentEl } = this; contentEl.createEl("h2", { text: this.kind === "expense" ? "Добавить расход" : "Добавить доход" });
    contentEl.createDiv({ text: "Операция сразу обновит доступную сумму и дневной лимит.", cls: "fs-modal-note" });
    new Setting(contentEl).setName("Сумма, ₽").addText(input => input.setPlaceholder("0").setValue(this.amount).onChange(v => this.amount = v));
    new Setting(contentEl).setName("Категория").addDropdown(dropdown => {
      const options = this.kind === "income" ? ["Доход", "Возврат", "Другое"] : Object.keys(categoryIcons);
      options.forEach(x => dropdown.addOption(x, x)); dropdown.setValue(this.category).onChange(v => this.category = v);
    });
    new Setting(contentEl).setName("Счёт").addDropdown(dropdown => { this.plugin.settings.accounts.forEach(a => dropdown.addOption(a.id, a.name)); dropdown.setValue(this.account).onChange(v => this.account = v); });
    new Setting(contentEl).setName("Дата").addText(input => { input.inputEl.type = "date"; input.setValue(this.date).onChange(v => this.date = v); });
    new Setting(contentEl).setName("Комментарий").addText(input => input.setPlaceholder("Например, продукты на неделю").onChange(v => this.note = v));
    new Setting(contentEl).addButton(button => button.setButtonText("Сохранить").setCta().onClick(async () => {
      const amount = Number(this.amount.replace(",", ".")); if (!Number.isFinite(amount) || amount <= 0) { new Notice("Введите сумму больше нуля"); return; }
      const account = this.plugin.settings.accounts.find(a => a.id === this.account); if (!account) { new Notice("Сначала добавьте счёт в настройках"); return; }
      account.balance += this.kind === "income" ? amount : -amount;
      await this.plugin.addTransaction({ id: crypto.randomUUID(), kind: this.kind, amount, category: this.category, account: this.account, note: this.note, date: this.date || dateKey() });
      this.close();
    }));
  }
}

class FinancialSpaceSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: FinancialSpacePlugin) { super(app, plugin); }
  display() {
    const { containerEl } = this; containerEl.empty(); containerEl.createEl("h2", { text: "Финансовое пространство" });
    containerEl.createEl("h3", { text: "Настройка прогноза" });
    new Setting(containerEl).setName("Ожидаемые доходы в этом месяце").setDesc("Доходы, которые ещё не пришли, но уже ожидаются.").addText(input => input.setValue(String(this.plugin.settings.expectedIncome || "")).onChange(async v => { this.plugin.settings.expectedIncome = Number(v) || 0; await this.plugin.saveSettings(); }));
    containerEl.createEl("h3", { text: "Markdown-журнал операций" });
    new Setting(containerEl).setName("Папка для журнала").setDesc("Путь относительно vault. Можно использовать {month}, например: Финансовое пространство/Операции/{month}").addText(input => input.setValue(this.plugin.settings.logsFolder).onChange(async value => { this.plugin.settings.logsFolder = value.trim() || DEFAULT_SETTINGS.logsFolder; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Шаблон имени файла").setDesc("Переменные: {date}, {month}, {kind}, {category}, {account}, {amount}, {id}. Расширение .md добавляется автоматически.").addText(input => { input.inputEl.style.width = "100%"; input.setValue(this.plugin.settings.logFileTemplate).onChange(async value => { this.plugin.settings.logFileTemplate = value.trim() || DEFAULT_SETTINGS.logFileTemplate; await this.plugin.saveSettings(); }); });
    containerEl.createEl("h3", { text: "Счета" });
    this.plugin.settings.accounts.forEach((account, index) => new Setting(containerEl).setName(account.name).setDesc(`Баланс: ${money(account.balance)}`).addButton(b => b.setButtonText("Удалить").setWarning().onClick(async () => { this.plugin.settings.accounts.splice(index, 1); await this.plugin.saveSettings(); this.display(); })));
    new Setting(containerEl).addButton(b => b.setButtonText("Добавить счёт").onClick(async () => { this.plugin.settings.accounts.push({ id: crypto.randomUUID(), name: "Новый счёт", balance: 0 }); await this.plugin.saveSettings(); this.display(); }));
    containerEl.createEl("h3", { text: "Бюджеты" });
    this.plugin.settings.budgets.forEach((budget, index) => new Setting(containerEl).setName(budget.category).setDesc(`Лимит: ${money(budget.limit)}`).addButton(b => b.setButtonText("Удалить").setWarning().onClick(async () => { this.plugin.settings.budgets.splice(index, 1); await this.plugin.saveSettings(); this.display(); })));
    new Setting(containerEl).setName("Добавить бюджет").addText(i => i.setPlaceholder("Категория").onChange(v => i.inputEl.dataset.category = v)).addText(i => i.setPlaceholder("Лимит, ₽").onChange(v => i.inputEl.dataset.limit = v)).addButton(b => b.setButtonText("Добавить").onClick(async () => { const inputs = Array.from(containerEl.querySelectorAll("input")); const category = inputs.at(-2)?.dataset.category?.trim(); const limit = Number(inputs.at(-1)?.dataset.limit); if (category && limit > 0) { this.plugin.settings.budgets.push({ category, limit }); await this.plugin.saveSettings(); this.display(); } else new Notice("Укажите категорию и лимит"); }));
    containerEl.createEl("h3", { text: "Регулярные платежи" });
    containerEl.createDiv({ text: "Будущие платежи вычитаются из доступной суммы до конца месяца.", cls: "setting-item-description" });
    this.plugin.settings.plannedPayments.forEach((payment, index) => new Setting(containerEl).setName(payment.title).setDesc(`${money(payment.amount)} · ${payment.day}-го числа`).addButton(b => b.setButtonText("Удалить").setWarning().onClick(async () => { this.plugin.settings.plannedPayments.splice(index, 1); await this.plugin.saveSettings(); this.display(); })));
    new Setting(containerEl).addButton(b => b.setButtonText("Добавить регулярный платёж").onClick(() => new PlannedPaymentModal(this.app, this.plugin).open()));
  }
}

class PlannedPaymentModal extends Modal {
  private title = ""; private amount = ""; private day = "";
  constructor(app: App, private plugin: FinancialSpacePlugin) { super(app); }
  onOpen() {
    const { contentEl } = this; contentEl.createEl("h2", { text: "Регулярный платёж" });
    contentEl.createDiv({ text: "Например: аренда, интернет или подписка.", cls: "fs-modal-note" });
    new Setting(contentEl).setName("Название").addText(i => i.setPlaceholder("Аренда").onChange(v => this.title = v));
    new Setting(contentEl).setName("Сумма, ₽").addText(i => i.setPlaceholder("0").onChange(v => this.amount = v));
    new Setting(contentEl).setName("День месяца").setDesc("Например, 5").addText(i => { i.inputEl.type = "number"; i.setPlaceholder("1–31").onChange(v => this.day = v); });
    new Setting(contentEl).addButton(b => b.setButtonText("Сохранить").setCta().onClick(async () => {
      const amount = Number(this.amount.replace(",", ".")); const day = Number(this.day);
      if (!this.title.trim() || amount <= 0 || !Number.isInteger(day) || day < 1 || day > 31) { new Notice("Заполните название, сумму и день от 1 до 31"); return; }
      this.plugin.settings.plannedPayments.push({ id: crypto.randomUUID(), title: this.title.trim(), amount, day });
      await this.plugin.saveSettings(); this.close();
    }));
  }
}
