export class Slugger {
  readonly separatorPattern = /[\s_-]+/g;
  slugify(text: string): string {
    return text.toLowerCase().trim().replace(this.separatorPattern, '-');
  }
}
