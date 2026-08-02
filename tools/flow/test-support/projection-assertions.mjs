export function withoutViewWatermarks(views) {
  return Object.fromEntries(Object.entries(structuredClone(views)).map(
    ([name, { authority_watermark: _watermark, ...view }]) => [name, view],
  ));
}
