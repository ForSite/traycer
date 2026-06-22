import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import type { TraycerUninstallResult } from "@traycer-clients/shared/platform/runner-host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerMutationKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";

/**
 * In-app "Remove Traycer" (Settings → General → Danger Zone). Stops + removes
 * the host service, host install, and (on macOS) the SMAppService login item,
 * and marks the device removed-by-user so the host is not auto-reinstalled
 * when it goes unreachable. All `~/.traycer` user data is preserved.
 *
 * Returns the raw mutation result so the Danger Zone can drive `isPending`
 * and switch to its success/quit state from `isSuccess`.
 */
export function useRunnerUninstallTraycer(): UseMutationResult<
  TraycerUninstallResult,
  Error,
  void
> {
  const { hostManagement } = useRunnerHost();
  return useMutation<TraycerUninstallResult>({
    mutationKey: runnerMutationKeys.uninstallTraycer(),
    mutationFn: () => {
      if (hostManagement === null) {
        return Promise.reject(
          new Error("Removing Traycer is not available on this platform."),
        );
      }
      return hostManagement.uninstallTraycer();
    },
    onError: (error) =>
      toastFromRunnerError(error, "Couldn't remove Traycer's components."),
  });
}
