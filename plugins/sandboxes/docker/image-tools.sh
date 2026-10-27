#!/bin/sh
# Image builds persist this selection. Old machines without it keep general tools.
bb_image_has() {
  case ",${BB_IMAGE_TOOLS-omp,claude-code,codex,fx,pi,prime-agent,fx-acp,nanocodex-acp,prime-agent-acp,python,go,rust,java,bun,deno,pnpm,docker,mise,nix,devbox,direnv,process-compose,aws,kubectl,helm,doppler,duckdb,op,clickhouse,postgresql,redis,sqlite,freeze,vhs,cua,build-tools,clang,cmake,ninja,gdb,protobuf,fzf,shellcheck,strace,tmux,vim,zsh}," in
    *",$1,"*) return 0 ;;
    *) return 1 ;;
  esac
}
