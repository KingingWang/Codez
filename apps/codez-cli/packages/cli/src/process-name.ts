export const CLI_COMMAND_NAME = "codez";
export const CLI_PROCESS_NAME = "codez-cli";

interface ProcessTitleTarget {
  title: string;
}

export const setCliProcessTitle = (
  target: ProcessTitleTarget = process,
): void => {
  target.title = CLI_PROCESS_NAME;
};
