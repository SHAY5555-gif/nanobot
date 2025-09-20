<script lang="ts">
	import type { ChatMessageItemResource } from '$lib/types';
	import { onMount } from 'svelte';

	interface Props {
		item: ChatMessageItemResource;
		onSend?: (message: string) => void;
		style?: Record<string, string>;
	}

	let { item, onSend, style = {} }: Props = $props();
	let container: HTMLDivElement;
	const iFrameRef = $state<{
		current: HTMLIFrameElement | null;
	}>({
		current: null
	});

	$effect(() => {
		if (iFrameRef.current) {
			// iFrameRef.current.classList.add('mx-auto');
			// console.log('Iframe ref:', iFrameRef.current);
		}
	});

	async function onUIAction(e: any) {
		const x = JSON.stringify(e);
		console.log(x);
		console.log('UI Action', e);
		switch (e.type) {
			case 'intent':
				if (
					e.payload.intent === 'link' &&
					e.payload.params?.url &&
					typeof e.payload.params.url === 'string'
				) {
					window.open(e.payload.params.url, '_blank');
				} else {
					console.log('UI Action:', e);
					onSend?.(JSON.stringify(e));
				}
				break;
			case 'tool':
			case 'prompt':
			case 'notify':
				console.log('UI Action:', e);
				onSend?.(JSON.stringify(e));
				break;
			case 'link':
				window.open(e.payload.url, '_blank');
				break;
		}
	}

	onMount(async () => {
		const [{ default: React }, reactDomClient, mcp] = await Promise.all([
			import('react'),
			import('react-dom/client'),
			import('@mcp-ui/client')
		]);
		const { createRoot } = reactDomClient as any;
		const {
			UIResourceRenderer,
			basicComponentLibrary,
			remoteButtonDefinition,
			remoteTextDefinition,
			remoteCardDefinition,
			remoteImageDefinition,
			remoteStackDefinition
		} = mcp as any;

		const root = createRoot(container);
		root.render(
			React.createElement(UIResourceRenderer, {
				onUIAction,
				resource: $state.snapshot(item.resource),
				remoteDomProps: {
					library: basicComponentLibrary,
					remoteElements: [
						remoteButtonDefinition,
						remoteTextDefinition,
						remoteCardDefinition,
						remoteImageDefinition,
						remoteStackDefinition
					]
				},
				htmlProps: {
					style: {
						...style
					},
					autoResizeIframe: true,
					iframeProps: {
						ref: iFrameRef
					}
				}
			})
		);
	});
</script>

<div bind:this={container} class="contents"></div>
