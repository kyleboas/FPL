#!/usr/bin/env python3
"""Plot autoresearch experiment progress from results.tsv.

Usage: python plot_progress.py [path/to/results.tsv]

Generates progress.png showing:
- Gray dots for discarded experiments
- Green dots for kept improvements
- Step line tracking the running best val_bpb
- Labels on each kept experiment with its description
"""
import sys
import pandas as pd
import matplotlib.pyplot as plt


def plot_progress(tsv_path="results.tsv", output_path="progress.png"):
    df = pd.read_csv(tsv_path, sep="\t")
    df["val_bpb"] = pd.to_numeric(df["val_bpb"], errors="coerce")
    df["memory_gb"] = pd.to_numeric(df["memory_gb"], errors="coerce")
    df["status"] = df["status"].str.strip().str.upper()

    # Filter out crashes for plotting
    valid = df[df["status"] != "CRASH"].copy()
    valid = valid.reset_index(drop=True)

    if len(valid) == 0:
        print("No valid experiments to plot.")
        return

    baseline_bpb = valid.loc[0, "val_bpb"]

    fig, ax = plt.subplots(figsize=(16, 8))

    # Discarded experiments as faint gray dots
    disc = valid[valid["status"] == "DISCARD"]
    ax.scatter(disc.index, disc["val_bpb"],
               c="#cccccc", s=30, alpha=0.5, zorder=2, label="Discarded")

    # Kept experiments as prominent green dots
    kept_v = valid[valid["status"] == "KEEP"]
    ax.scatter(kept_v.index, kept_v["val_bpb"],
               c="#2ecc71", s=80, zorder=4, label="Kept",
               edgecolors="white", linewidths=0.8)

    # Running best step line
    kept_mask = valid["status"] == "KEEP"
    kept_idx = valid.index[kept_mask]
    kept_bpb = valid.loc[kept_mask, "val_bpb"]
    running_min = kept_bpb.cummin()

    # Extend step line to end of x-axis
    extended_idx = list(kept_idx) + [valid.index[-1]]
    extended_min = list(running_min) + [running_min.iloc[-1]]
    ax.step(extended_idx, extended_min, where="post", color="#27ae60",
            linewidth=2.5, alpha=0.7, zorder=3, label="Running best")

    # Label each kept experiment
    for idx, bpb in zip(kept_idx, kept_bpb):
        desc = str(valid.loc[idx, "description"]).strip()
        if len(desc) > 45:
            desc = desc[:42] + "..."
        ax.annotate(desc, (idx, bpb),
                    textcoords="offset points",
                    xytext=(6, 6), fontsize=7.5,
                    color="#1a7a3a", alpha=0.85,
                    rotation=25, ha="left", va="bottom",
                    fontstyle="italic")

    n_total = len(df)
    n_kept = len(df[df["status"] == "KEEP"])
    ax.set_xlabel("Experiment #", fontsize=12)
    ax.set_ylabel("Validation BPB (lower is better)", fontsize=12)
    ax.set_title(f"Autoresearch Progress: {n_total} Experiments, "
                 f"{n_kept} Kept Improvements", fontsize=14)
    ax.legend(loc="upper right", fontsize=10, framealpha=0.9)
    ax.grid(True, alpha=0.2)

    # Y-axis limits
    best_bpb = running_min.iloc[-1] if len(running_min) > 0 else baseline_bpb
    margin = max((baseline_bpb - best_bpb) * 0.15, 0.0005)
    ax.set_ylim(best_bpb - margin, baseline_bpb + margin)

    plt.tight_layout()
    plt.savefig(output_path, dpi=150, bbox_inches="tight")
    print(f"Saved to {output_path}")


if __name__ == "__main__":
    tsv = sys.argv[1] if len(sys.argv) > 1 else "results.tsv"
    plot_progress(tsv)
