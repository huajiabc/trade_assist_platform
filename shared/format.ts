/** Preserve meaningful digits for low-price instruments instead of displaying zero. */
export function formatPrice(value: number, useGrouping = true): string {
  const magnitude = Math.abs(value);
  if (magnitude > 0 && magnitude < 0.0001) return value.toExponential(6);
  return new Intl.NumberFormat('en-US', {
    useGrouping,
    minimumFractionDigits: 2,
    maximumFractionDigits: Math.max(2, 6 - Math.floor(Math.log10(magnitude || 1))),
  }).format(value);
}
