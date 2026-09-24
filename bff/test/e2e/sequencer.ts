import { BaseSequencer, type TestSpecification } from 'vitest/node';

/** E2E 檔案依檔名順序執行(會中斷服務的韌性測試放在最後) */
export default class NameSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  }
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    return files;
  }
}
