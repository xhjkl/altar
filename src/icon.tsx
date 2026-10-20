const paths = {
  chevron: "m8 5 6 5-6 5",
  search: "M14 14l4 4M16 9A7 7 0 1 1 2 9a7 7 0 0 1 14 0",
  play: "m6 3 11 7-11 7V3Z",
  down: "M10 3v14m-5-5 5 5 5-5",
  panel: "M5 3h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM8 3v14",
};
export default function Icon(props: { name: keyof typeof paths; size?: number }) {
  return <svg width={props.size ?? 18} height={props.size ?? 18} viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={paths[props.name]} /></svg>;
}
