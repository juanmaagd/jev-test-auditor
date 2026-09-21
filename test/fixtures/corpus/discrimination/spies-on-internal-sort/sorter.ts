export class NumberSorter {
  sortNumbers(nums: readonly number[]): number[] {
    return this.quickSort([...nums]);
  }
  quickSort(nums: number[]): number[] {
    return nums.sort((a, b) => a - b);
  }
}
