import { describe, expect, it } from 'vitest';
import {
  assertVideoChat3WorkerReady,
  diagnoseVideoChat3StartupFailure,
} from '../src/worker/startup/videochat3.js';

describe('VideoChat3 worker startup diagnostic', () => {
  it('names a stale or incompatible Modal deployment explicitly', () => {
    expect(
      diagnoseVideoChat3StartupFailure(
        "Modal cannot find clipit-videochat3/VideoChat3Service in main (Method 'watch_stream' not found on class)",
      ),
    ).toBe('modal_deployment_contract_mismatch');
  });

  it('separates authentication failures from deployment drift', () => {
    expect(diagnoseVideoChat3StartupFailure("Modal rejected Clipit's credentials (unauthorized)")).toBe(
      'modal_auth_failure',
    );
  });

  it('keeps unknown dependency failures distinct', () => {
    expect(diagnoseVideoChat3StartupFailure('Modal call failed: connection reset')).toBe(
      'videochat3_unavailable',
    );
  });

  it('fails worker startup with the deployment diagnosis before jobs start', async () => {
    await expect(
      assertVideoChat3WorkerReady(async () => {
        throw new Error("Method 'watch_stream' not found on class");
      }),
    ).rejects.toThrow(
      'VideoChat3 worker startup check failed [modal_deployment_contract_mismatch]',
    );
  });

  it('passes when the deployed method contract resolves', async () => {
    await expect(assertVideoChat3WorkerReady(async () => undefined)).resolves.toBeUndefined();
  });
});
