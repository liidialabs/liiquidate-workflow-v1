# =========================
# Chainlink CRE Makefile
# =========================

# Load .env
-include .env

# Binaries
CRE ?= cre

# Defaults
WORKFLOW ?= liiquidate-workflow
TARGET ?= staging-settings

# Phony targets
.PHONY: help simulate simulate-bc

# =========================
# Help
# =========================
help:
	@echo "Chainlink CRE Makefile"
	@echo ""
	@echo "Core commands:"
	@echo "  make simulate             -> simulate workflow"
	@echo "  make simulate-bc          -> simulate workflow and broadcast"
	@echo ""
	@echo "Overrides:"
	@echo "  make simulate WORKFLOW=x TARGET=y"
	@echo "  make simulate-bc WORKFLOW=x TARGET=y"

# =========================
# Core commands
# =========================

simulate:
	$(CRE) workflow simulate $(WORKFLOW) --target $(TARGET)

simulate-bc:
	$(CRE) workflow simulate $(WORKFLOW) --target $(TARGET) --broadcast

