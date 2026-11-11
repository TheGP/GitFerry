export function PaneExpandButton(props: { pane: "Changes" | "editor"; expanded: boolean; onToggle: () => void }) {
  const label = () => `${props.expanded ? "Restore" : "Expand"} ${props.pane} pane`;
  return <button type="button" class="pane-expand" aria-label={label()} aria-pressed={props.expanded}
    aria-keyshortcuts={props.pane === "Changes" ? "Meta+Shift+1 Control+Shift+1" : "Meta+Shift+2 Control+Shift+2"}
    title={`${label()} (Cmd/Ctrl+Shift+${props.pane === "Changes" ? "1" : "2"})${props.expanded ? "; Esc to restore" : ""}`}
    onMouseDown={event => event.preventDefault()} onClick={props.onToggle}>
    <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
      <path d={props.expanded ? "M2 6h4V2M14 10h-4v4M6 6 1 1m9 9 5 5" : "M6 2H2v4m8 8h4v-4M2 2l4 4m8 8-4-4"} />
    </svg>
  </button>;
}
