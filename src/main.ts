import { Notice, Plugin } from 'obsidian';
import { VIEW_TYPE_GALAXY } from './constants';
import type { GalaxySettings } from './settings';
import { DEFAULT_SETTINGS, mergeSettings } from './settings';
import { resolveLang, setLang, t } from './i18n';
import { GalaxySettingTab } from './settings/SettingsTab';
import { GalaxyView } from './view/GalaxyView';
import { heapUsed, sleep, writeBenchResult } from './bench/bench';

export default class GalaxyViewPlugin extends Plugin {
	settings: GalaxySettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		this.settings = mergeSettings(await this.loadData());
		setLang(resolveLang(this.settings.language)); // Command names/ribbon need the language resolved before registration
		this.registerView(VIEW_TYPE_GALAXY, (leaf) => new GalaxyView(leaf, this));
		this.addSettingTab(new GalaxySettingTab(this.app, this));

		this.addRibbonIcon('orbit', t('cmd.open'), () => {
			void this.activateView();
		});

		this.addCommand({
			id: 'open',
			name: t('cmd.open'),
			callback: () => void this.activateView(),
		});

		this.addCommand({
			id: 'search',
			name: t('cmd.search'),
			callback: () => {
				void this.activateView().then((view) => view?.controller?.openSearch());
			},
		});

		this.addCommand({
			id: 'tour',
			name: t('cmd.tour'),
			callback: () => {
				void this.activateView().then((view) => view?.controller?.toggleTour());
			},
		});

		if (!__GALAXY_DEV__) return; // Dev-only benchmark commands below; stripped from store builds

		this.addCommand({
			id: 'bench-suite',
			name: 'Benchmark: orbit, cold layout, with unresolved',
			callback: () => void this.runBenchSuite(),
		});

		this.addCommand({
			id: 'bench-leak',
			name: 'Benchmark: leak detection (repeatedly open/close view)',
			callback: () => void this.runLeakCanary(),
		});
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async activateView(): Promise<GalaxyView | null> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_GALAXY)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getLeaf(true);
			await leaf.setViewState({ type: VIEW_TYPE_GALAXY, active: true });
		}
		if (leaf.isDeferred) await leaf.loadIfDeferred();
		await workspace.revealLeaf(leaf);
		return leaf.view instanceof GalaxyView ? leaf.view : null;
	}

	private async runBenchSuite(): Promise<void> {
		const view = await this.activateView();
		if (!view) {
			new Notice(t('notice.openFail'));
			return;
		}
		// 等控制器完成异步启动
		for (let i = 0; i < 100 && !view.controller; i++) await sleep(100);
		const c = view.controller;
		if (!c) {
			new Notice(t('notice.initTimeout'));
			return;
		}
		await c.runScenario('S1');
		await c.runScenario('S2');
		await c.runScenario('S3');
		new Notice('Benchmark complete, results in the _galaxy_bench/ folder');
	}

	/** S4：开关视图×10，看堆增量与 WebGL 上下文告警（后者看控制台） */
	private async runLeakCanary(): Promise<void> {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_GALAXY);
		await sleep(500);
		const before = heapUsed();
		let counts = { nodes: 0, links: 0 };
		const cycles = 10;
		for (let i = 0; i < cycles; i++) {
			const view = await this.activateView();
			await sleep(2000);
			if (view) counts = view.counts;
			this.app.workspace.detachLeavesOfType(VIEW_TYPE_GALAXY);
			await sleep(400);
			new Notice(`S4：${i + 1}/${cycles}`);
		}
		// 布局 tick 产生大量短命垃圾（d3 每 tick 重建八叉树），忙循环期间整堆回收
		// 不一定跑——等空闲回收收尾后再读数，否则把回收滞后误判成泄漏（2026-06-12 实测）
		new Notice('Benchmark: waiting for garbage collection…');
		await sleep(20_000);
		const after = heapUsed();
		const result = {
			scenario: 'S4',
			timestamp: new Date().toISOString(),
			nodes: counts.nodes,
			links: counts.links,
			bloom: true,
			renderer: 'aggregate',
			cycles,
			heapBeforeMB: before / 1048576,
			heapAfterMB: after / 1048576,
			heapDeltaMB: (after - before) / 1048576,
			note: 'Check the developer console for WebGL context warnings; a real leak = "before" keeps rising over two consecutive rounds',
		};
		await writeBenchResult(this.app, result);
		new Notice(`S4 complete: heap delta ${result.heapDeltaMB.toFixed(1)} MB (pass threshold <20MB)`);
	}
}
