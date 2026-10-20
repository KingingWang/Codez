import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { $getRoot, COMMAND_PRIORITY_HIGH, KEY_ENTER_COMMAND } from "lexical";

interface ProbeState {
  events: string[];
  submitCount: number;
  text: string;
}

const probe: ProbeState = { events: [], submitCount: 0, text: "" };
Object.assign(window, { __lexicalImeProbe: probe });

function ProbePlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const unregisterEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (!event || event.isComposing) return false;
        event.preventDefault();
        probe.submitCount += 1;
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterUpdate = editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        probe.text = $getRoot().getTextContent();
      });
    });
    const record = (event: Event) => {
      const input = event as InputEvent;
      probe.events.push(
        `${event.type}:${input.data ?? ""}:${input.inputType ?? ""}:${input.isComposing ?? ""}`,
      );
    };
    const unregisterRoot = editor.registerRootListener((root, previousRoot) => {
      for (const type of ["compositionend", "beforeinput", "input"]) {
        previousRoot?.removeEventListener(type, record);
        root?.addEventListener(type, record);
      }
    });
    return () => {
      unregisterEnter();
      unregisterUpdate();
      unregisterRoot();
      const root = editor.getRootElement();
      for (const type of ["compositionend", "beforeinput", "input"]) {
        root?.removeEventListener(type, record);
      }
    };
  }, [editor]);
  return null;
}

createRoot(document.getElementById("root")!).render(
  <LexicalComposer
    initialConfig={{
      namespace: "LexicalImeRegression",
      onError: (error) => {
        throw error;
      },
    }}
  >
    <PlainTextPlugin
      contentEditable={<ContentEditable aria-label="IME probe" />}
      placeholder={null}
      ErrorBoundary={LexicalErrorBoundary}
    />
    <ProbePlugin />
  </LexicalComposer>,
);
